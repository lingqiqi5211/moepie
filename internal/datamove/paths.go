package datamove

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"

	"github.com/yetone/magpie/internal/appdir"
)

func validMode(mode string) bool { return mode == appdir.ModeInstalled || mode == appdir.ModePortable }

// noLinks checks the root as well as every existing ancestor. Migration
// never follows a redirected data root, including a Windows junction.
func noLinks(path string) error {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		st, err := os.Lstat(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && (!st.IsDir() || st.Mode()&os.ModeSymlink != 0) {
			return fmt.Errorf("data path is not an unlinked directory: %s", p)
		}
		if filepath.Dir(p) == p {
			return nil
		}
	}
}

func pathKey(p string) string {
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

// validatePaths binds a record to this executable and the two fixed places.
// No external root can be substituted by a stale or malformed record.
func validatePaths(exe string, tx *Transaction) error {
	if !validMode(tx.From) || !validMode(tx.To) || tx.From == tx.To || pathKey(tx.Exe) != pathKey(exe) {
		return errors.New("invalid data move identity or modes")
	}
	expected, err := Pairs(exe, tx.From, tx.To)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(expected, tx.Pairs) {
		return errors.New("data move no longer names the fixed data directories")
	}
	for _, p := range tx.Pairs {
		for _, d := range []string{p.From, p.To} {
			if !filepath.IsAbs(d) {
				return errors.New("data move needs absolute paths")
			}
			if err := noLinks(d); err != nil {
				return err
			}
			if contains(pathKey(d), pathKey(exe)) || contains(pathKey(d), pathKey(appdir.ModePath(exe))) {
				return fmt.Errorf("data directory overlaps the program: %s", d)
			}
		}
		for _, q := range tx.Pairs {
			if contains(pathKey(p.From), pathKey(q.To)) || contains(pathKey(q.To), pathKey(p.From)) {
				return errors.New("source and destination data directories overlap")
			}
		}
	}
	// Only portable's documented nested cache/profile mapping is supported.
	for _, side := range []func(Pair) string{from, to} {
		for i, p := range tx.Pairs {
			for j, q := range tx.Pairs {
				if i == j {
					continue
				}
				if pathKey(side(p)) == pathKey(side(q)) {
					return errors.New("data directories alias each other")
				}
				if contains(pathKey(side(p)), pathKey(side(q))) && pathKey(side(p)) != pathKey(appdir.PortableData(exe)) {
					return errors.New("installed data directories overlap")
				}
			}
		}
	}
	if tx.ID != "" {
		if _, err := hex.DecodeString(tx.ID); err != nil || len(tx.ID) != 32 {
			return errors.New("invalid data move ID")
		}
	}
	for _, plan := range tx.Cleanup {
		known := false
		for _, p := range tx.Pairs {
			if plan.Pair == p {
				known = true
			}
		}
		if !known || plan.Identity == "" {
			return errors.New("invalid source cleanup identity")
		}
		for rel, item := range plan.Entries {
			if rel == "." || filepath.IsAbs(rel) || filepath.Clean(rel) != rel || !contains(plan.Pair.From, filepath.Join(plan.Pair.From, rel)) || skippedPath(rel, cleanupSkip(tx, plan.Pair)) || (!item.Mode.IsDir() && !item.Mode.IsRegular()) {
				return errors.New("invalid source cleanup entry")
			}
		}
	}
	for target, backup := range tx.Backups {
		known := false
		for _, p := range tops(tx.Pairs) {
			if target == p.To {
				known = true
			}
		}
		if !known || !strings.HasPrefix(backup, target+".backup-") || filepath.Dir(backup) != filepath.Dir(target) {
			return errors.New("invalid data backup path")
		}
		if err := noLinks(backup); err != nil {
			return err
		}
	}
	return nil
}
