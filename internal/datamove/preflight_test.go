package datamove

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/yetone/magpie/internal/appdir"
)

// Reading Settings must not turn an installed app into a portable one on
// its next start just by probing the destination's permissions.
func TestPreflightDoesNotSelectPortable(t *testing.T) {
	e := exe(t)
	installedData(t, e)
	if got := appdir.Resolve(e); got != "" {
		t.Fatalf("fixture already portable: %q", got)
	}
	for range 2 {
		if err := Preflight(e, appdir.ModePortable); err != nil {
			t.Fatal(err)
		}
	}
	if got := appdir.Resolve(e); got != "" {
		t.Fatalf("checking the destination changed the next startup directory to %q", got)
	}
	if _, err := os.Stat(appdir.PortableData(e)); !os.IsNotExist(err) {
		t.Fatalf("preflight created the portable directory: %v", err)
	}
	if _, err := os.Stat(appdir.ModePath(e)); !os.IsNotExist(err) {
		t.Fatalf("preflight wrote a mode choice: %v", err)
	}
}

func TestIncompleteMoveKeepsInstalledSelection(t *testing.T) {
	for _, phase := range []string{"prepared", "authorized", "published"} {
		t.Run(phase, func(t *testing.T) {
			e := exe(t)
			src := installedData(t, e)
			tx, err := Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil)
			if err != nil {
				t.Fatal(err)
			}
			if phase != "prepared" {
				if err := Authorize(context.Background(), e, tx.ID); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "published" {
				old := afterPublish
				afterPublish = func() error { return errors.New("before mode switch") }
				t.Cleanup(func() { afterPublish = old })
				if err := Run(context.Background(), e); err == nil {
					t.Fatal("move unexpectedly succeeded")
				}
			} else if err := Abort(e, tx.ID, "helper unavailable"); err != nil {
				t.Fatal(err)
			}
			if got := appdir.Resolve(e); got != "" {
				t.Fatalf("incomplete move selected portable data: %q", got)
			}
			if read(t, filepath.Join(src.Config, "settings.json")) != `{"a":1}` {
				t.Fatal("source settings changed")
			}
			if exists(appdir.PortableData(e)) || exists(appdir.ModePath(e)) {
				t.Fatal("incomplete move left a portable directory or mode choice")
			}
		})
	}
}

func TestWritableMissingDirectoryDoesNotCreateIt(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "not-created", "nested")
	if err := Writable(missing); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("writability probe left files or directories: %v", entries)
	}
}
