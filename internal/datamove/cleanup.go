package datamove

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
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
		for rel, item := range entries {
			if item.Mode&os.ModeSymlink == 0 {
				continue
			}
			target, err := os.Readlink(filepath.Join(p.From, rel))
			if err != nil {
				return err
			}
			resolved, err := filepath.EvalSymlinks(target)
			if err != nil {
				return err
			}
			for _, pair := range tx.Pairs {
				if contains(pathKey(pair.From), pathKey(target)) || contains(pathKey(pair.To), pathKey(target)) || contains(pathKey(pair.From), pathKey(resolved)) || contains(pathKey(pair.To), pathKey(resolved)) {
					return fmt.Errorf("link target is inside data being moved: %s", filepath.Join(p.From, rel))
				}
			}
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
		if cachePair(tx, p) {
			// Not copied, so its folder can't otherwise be emptied.
			if err := removeInstallCache(p.From); err != nil {
				problems = append(problems, err.Error())
			}
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
			if st.Mode().Type() != original.Mode.Type() || (!st.IsDir() && !st.Mode().IsRegular() && st.Mode()&os.ModeSymlink == 0) {
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

// dropSources takes each old data folder out once its move is complete:
// cleanup has emptied it of data, leaving only runtime files and folders.
// It runs with the gates let go, as Windows removes no open file. A folder
// still holding anything else, or not this move's, is left.
func dropSources(exe string, tx *Transaction) {
	if tx.State != StateComplete {
		return
	}
	for _, p := range tx.Pairs {
		root := p.From
		if inside(tx.Pairs, root, from) != "" || contains(root, exe) || overlapsTarget(tx, root) {
			continue
		}
		if b, err := os.ReadFile(filepath.Join(root, runtimeName, sourceOwner)); err != nil || string(b) != tx.ID {
			continue
		}
		if noLinks(root) != nil || !onlyRuntime(root) {
			continue
		}
		_ = removeCache(root)
	}
}

func overlapsTarget(tx *Transaction, dir string) bool {
	for _, q := range tx.Pairs {
		if contains(dir, q.To) || contains(q.To, dir) {
			return true
		}
	}
	return false
}

// onlyRuntime is whether root holds folders and, in runtime folders,
// plain files only: no data, links or other kinds of file.
func onlyRuntime(root string) bool {
	ok := true
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if !d.Type().IsRegular() || !slices.Contains(strings.Split(rel, string(filepath.Separator)), runtimeName) {
			ok = false
			return filepath.SkipAll
		}
		return nil
	})
	return err == nil && ok
}

func fileEntry(path string) (entry, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return entry{}, err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(path)
		if err != nil {
			return entry{}, err
		}
		h := sha256.Sum256([]byte(target))
		return entry{Mode: st.Mode(), Size: int64(len(target)), Hash: hex.EncodeToString(h[:])}, nil
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
	return a.Mode.Type() == b.Mode.Type() && a.Size == b.Size && a.Hash == b.Hash
}

// Removal is injectable for disk errors and interrupted cleanup tests.
var removeSource = os.Remove

// removeCache removes a tree. Links in it are removed, never followed.
var removeCache = os.RemoveAll

// removeInstallCache takes Bun's install cache out of an old cache folder.
func removeInstallCache(root string) error {
	path := filepath.Join(root, installCache)
	if err := noLinks(filepath.Dir(path)); err != nil {
		return err
	}
	return removeCache(path)
}
