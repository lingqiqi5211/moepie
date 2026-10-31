package datamove

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const sourceOwner = "cleanup-owner"

// CleanupPlan is persisted before publication. It binds deletion to the
// source's identity marker and the exact files observed while writers were off.
type CleanupPlan struct {
	Identity string           `json:"identity"`
	Pair     Pair             `json:"pair"`
	Entries  map[string]entry `json:"entries"`
}

func cleanupSkip(tx *Transaction, p Pair) func(string) bool {
	p.Web = false
	return skipper(tx, p, from)
}

func captureSources(exe string, tx *Transaction) error {
	tx.Cleanup = nil
	for _, p := range tx.Pairs {
		if err := os.MkdirAll(filepath.Join(p.From, runtimeName), 0700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(p.From, runtimeName, sourceOwner), []byte(tx.ID), 0600); err != nil {
			return err
		}
		identity, err := rootIdentity(p.From)
		if err != nil {
			return err
		}
		entries, err := manifest(p.From, cleanupSkip(tx, p))
		if err != nil {
			return err
		}
		tx.Cleanup = append(tx.Cleanup, CleanupPlan{Pair: p, Entries: entries, Identity: identity})
	}
	return save(exe, tx)
}

func verifySources(tx *Transaction) error {
	for _, plan := range tx.Cleanup {
		got, err := manifest(plan.Pair.From, cleanupSkip(tx, plan.Pair))
		if err != nil {
			return err
		}
		if !sameData(plan.Entries, got) {
			return fmt.Errorf("source changed during migration: %s", plan.Pair.From)
		}
	}
	return nil
}

// verifyPublished precedes the irreversible boundary and recovery of a
// published record. A mode pointer alone is never proof that copying succeeded.
func verifyPublished(tx *Transaction) error {
	if len(tx.Cleanup) != len(tx.Pairs) {
		return errors.New("data move has no verified cleanup manifest")
	}
	for _, p := range tx.Pairs {
		var original map[string]entry
		for _, plan := range tx.Cleanup {
			if plan.Pair == p {
				original = plan.Entries
			}
		}
		if original == nil {
			return errors.New("data move cleanup manifest names another root")
		}
		expected := map[string]entry{}
		for rel, item := range original {
			if !skippedPath(rel, skipper(tx, p, from)) {
				expected[rel] = item
			}
		}
		got, err := manifest(p.To, skipper(tx, p, to))
		if err != nil {
			return err
		}
		if !sameData(expected, got) {
			return fmt.Errorf("published copy differs from verified source: %s", p.To)
		}
	}
	return nil
}

func skippedPath(rel string, skip func(string) bool) bool {
	for p := rel; p != "."; p = filepath.Dir(p) {
		if skip(p) {
			return true
		}
	}
	return false
}

// cleanup never rolls back: the mode pointer already selects the new data.
// Each removal checks the source identity, ancestors and original bytes. A
// changed or new file is left for a later retry and named in the result.
func cleanup(ctx context.Context, exe string, tx *Transaction) error {
	tx.State = StateCleanup
	if !tx.CleanupStarted {
		if err := verifyPublished(tx); err != nil {
			tx.Error = err.Error()
			_ = save(exe, tx)
			return err
		}
		tx.CleanupStarted = true
	}
	if err := save(exe, tx); err != nil {
		return err
	}
	var problems []string
	for _, plan := range tx.Cleanup {
		p := plan.Pair
		if err := noLinks(p.From); err != nil {
			problems = append(problems, err.Error())
			continue
		}
		identity, identityErr := rootIdentity(p.From)
		if identityErr != nil || identity != plan.Identity {
			problems = append(problems, "source root identity changed: "+p.From)
			continue
		}
		marker, err := os.ReadFile(filepath.Join(p.From, runtimeName, sourceOwner))
		if err != nil || string(marker) != tx.ID {
			problems = append(problems, "source identity changed: "+p.From)
			continue
		}
		names := make([]string, 0, len(plan.Entries))
		for name := range plan.Entries {
			names = append(names, name)
		}
		sort.Slice(names, func(i, j int) bool { return len(names[i]) > len(names[j]) })
		for _, rel := range names {
			if err := ctx.Err(); err != nil {
				problems = append(problems, err.Error())
				break
			}
			path := filepath.Join(p.From, rel)
			if !contains(p.From, path) {
				problems = append(problems, "invalid cleanup path: "+path)
				continue
			}
			if err := noLinks(filepath.Dir(path)); err != nil {
				problems = append(problems, err.Error())
				continue
			}
			st, err := os.Lstat(path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				problems = append(problems, path+": "+err.Error())
				continue
			}
			original := plan.Entries[rel]
			if st.Mode()&os.ModeSymlink != 0 || st.IsDir() != original.Mode.IsDir() || (!st.IsDir() && !st.Mode().IsRegular()) {
				problems = append(problems, "source type changed: "+path)
				continue
			}
			if !st.IsDir() {
				current, err := fileEntry(path)
				if err != nil || !sameEntry(original, current) {
					problems = append(problems, "source changed: "+path)
					continue
				}
				if !skippedPath(rel, skipper(tx, p, from)) {
					target := filepath.Join(p.To, rel)
					if err := noLinks(filepath.Dir(target)); err != nil {
						problems = append(problems, err.Error())
						continue
					}
					copied, err := fileEntry(target)
					if err != nil || !sameEntry(original, copied) {
						problems = append(problems, "destination changed; retained source: "+path)
						continue
					}
				}
			}
			if err := removeSource(path); err != nil {
				problems = append(problems, path+": "+err.Error())
			}
		}
		// New files were never in the verified manifest and must never be erased.
		remaining, err := manifest(p.From, cleanupSkip(tx, p))
		if err != nil {
			problems = append(problems, err.Error())
		} else if len(remaining) > 0 {
			problems = append(problems, "uncleaned data remains in "+p.From)
		}
	}
	unblock(targets(tx))
	for _, p := range tops(tx.Pairs) {
		os.Remove(filepath.Join(p.To, runtimeName, stageOwner))
	}
	if len(problems) > 0 {
		tx.Error = "Data moved; old data cleanup is incomplete: " + strings.Join(problems, "; ")
		if err := save(exe, tx); err != nil {
			return err
		}
		return errors.New(tx.Error)
	}
	tx.State, tx.Error = StateComplete, ""
	return save(exe, tx)
}

func fileEntry(path string) (entry, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return entry{}, err
	}
	if !st.Mode().IsRegular() {
		return entry{}, fmt.Errorf("not a regular file: %s", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return entry{}, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(st, opened) {
		return entry{}, errors.New("file identity changed")
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	return entry{Mode: st.Mode(), Size: n, Hash: hex.EncodeToString(h.Sum(nil))}, err
}

func sameEntry(a, b entry) bool {
	return a.Mode.IsDir() == b.Mode.IsDir() && a.Size == b.Size && a.Hash == b.Hash
}

// Removal is injectable for disk errors and interrupted cleanup tests.
var removeSource = os.Remove
