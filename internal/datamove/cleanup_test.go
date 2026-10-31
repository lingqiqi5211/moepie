package datamove

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/appdir"
)

func TestCleanupFailureKeepsCommittedRootAndCanRetry(t *testing.T) {
	e := exe(t)
	src := installedData(t, e)
	old := removeSource
	removeSource = func(path string) error { return errors.New("synthetic cleanup denied") }
	t.Cleanup(func() { removeSource = old })
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err == nil {
		t.Fatal("cleanup failure was hidden")
	}
	tx, err := Status(e)
	if err != nil || tx.State != StateCleanup || !strings.Contains(tx.Error, "synthetic cleanup denied") {
		t.Fatalf("record %+v: %v", tx, err)
	}
	mode, _ := appdir.ReadMode(e)
	if mode != appdir.ModePortable {
		t.Fatal("committed mode rolled back")
	}
	dst, _ := PlacesOf(e, mode)
	if read(t, filepath.Join(dst.Config, "settings.json")) != `{"a":1}` || !exists(filepath.Join(src.Config, "settings.json")) {
		t.Fatal("copies lost")
	}
	if err := Settle(e); err != nil {
		t.Fatal("cleanup failure prevented new-root startup", err)
	}
	if err := Cancel(e); err != nil {
		t.Fatal(err)
	}
	if mode, _ := appdir.ReadMode(e); mode != appdir.ModePortable {
		t.Fatal("cancel restored source")
	}
	removeSource = old
	if _, err := RetryCleanup(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	if err := Run(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	tx, _ = Status(e)
	if tx.State != StateComplete || exists(filepath.Join(src.Config, "settings.json")) {
		t.Fatal("retry did not complete", tx)
	}
}

func TestCleanupInterruptedAfterRemovalResumes(t *testing.T) {
	e := exe(t)
	src := installedData(t, e)
	old := removeSource
	removed := false
	removeSource = func(path string) error {
		if !removed {
			if err := old(path); err != nil {
				return err
			}
			removed = true
			panic("synthetic interruption")
		}
		return old(path)
	}
	t.Cleanup(func() { removeSource = old })
	func() {
		defer func() {
			if recover() == nil {
				t.Error("no interruption")
			}
		}()
		_ = runMove(t, e, appdir.ModeInstalled, appdir.ModePortable)
	}()
	tx, _ := Status(e)
	if tx.State != StateCleanup || !tx.CleanupStarted {
		t.Fatalf("missing durable cleanup boundary: %+v", tx)
	}
	removeSource = old
	if err := Settle(e); err != nil {
		t.Fatal(err)
	}
	tx, _ = Status(e)
	if tx.State != StateComplete || exists(filepath.Join(src.Config, "settings.json")) || exists(filepath.Join(src.Cache, "models.json")) {
		t.Fatalf("interruption not resumed: %+v", tx)
	}
	if mode, _ := appdir.ReadMode(e); mode != appdir.ModePortable {
		t.Fatal("mode restored after deletion")
	}
}

func TestVerificationFailureNeverDeletesSource(t *testing.T) {
	for _, change := range []string{"source", "destination"} {
		t.Run(change, func(t *testing.T) {
			e := exe(t)
			src := installedData(t, e)
			dst, _ := PlacesOf(e, appdir.ModePortable)
			afterPublish = func() error {
				path := filepath.Join(dst.Config, "settings.json")
				if change == "source" {
					path = filepath.Join(src.Config, "settings.json")
				}
				return os.WriteFile(path, []byte("changed"), 0600)
			}
			t.Cleanup(func() { afterPublish = func() error { return nil } })
			if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err == nil {
				t.Fatal("invalid copy accepted")
			}
			if !exists(filepath.Join(src.Config, "settings.json")) || !exists(filepath.Join(src.Cache, "models.json")) {
				t.Fatal("unverified source deleted")
			}
			if mode, _ := appdir.ReadMode(e); mode != "" {
				t.Fatal("unverified destination selected")
			}
			tx, _ := Status(e)
			if tx.State != StateFailed {
				t.Fatalf("state %+v", tx)
			}
		})
	}
}

func TestCleanupRefusesChangedSourceAndDestination(t *testing.T) {
	for _, change := range []string{"source", "destination", "identity"} {
		t.Run(change, func(t *testing.T) {
			e := exe(t)
			src := installedData(t, e)
			old := removeSource
			removeSource = func(string) error { return errors.New("hold cleanup") }
			t.Cleanup(func() { removeSource = old })
			if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err == nil {
				t.Fatal("expected cleanup hold")
			}
			tx, _ := Status(e)
			dst, _ := PlacesOf(e, appdir.ModePortable)
			switch change {
			case "source":
				write(t, filepath.Join(src.Config, "settings.json"), "new source")
			case "destination":
				write(t, filepath.Join(dst.Config, "settings.json"), "new destination")
			case "identity":
				if err := os.Rename(src.Config, src.Config+".replaced"); err != nil {
					t.Fatal(err)
				}
				write(t, filepath.Join(src.Config, runtimeName, sourceOwner), tx.ID)
				write(t, filepath.Join(src.Config, "settings.json"), `{"a":1}`)
			}
			removeSource = old
			if err := Settle(e); err != nil {
				t.Fatal(err)
			}
			tx, _ = Status(e)
			if tx.State != StateCleanup || !exists(filepath.Join(src.Config, "settings.json")) {
				t.Fatal("changed or redirected source deleted", tx)
			}
			if mode, _ := appdir.ReadMode(e); mode != appdir.ModePortable {
				t.Fatal("committed destination lost")
			}
		})
	}
}

func TestPrepareRefusesOverlapLinksAndUnreadableJournal(t *testing.T) {
	t.Run("overlap", func(t *testing.T) {
		e := exe(t)
		t.Setenv("XDG_CONFIG_HOME", filepath.Join(filepath.Dir(e), "data"))
		if _, err := Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil); err == nil {
			t.Fatal("overlapping roots accepted")
		}
	})
	t.Run("root link", func(t *testing.T) {
		e := exe(t)
		src := installedData(t, e)
		alias := src.Config + ".actual"
		if err := os.Rename(src.Config, alias); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(alias, src.Config); err != nil {
			t.Skip("host cannot create symlink", err)
		}
		if _, err := Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil); err == nil {
			t.Fatal("linked root accepted")
		}
		if read(t, filepath.Join(alias, "settings.json")) != `{"a":1}` {
			t.Fatal("linked data changed")
		}
	})
	t.Run("linked child", func(t *testing.T) {
		e := exe(t)
		src := installedData(t, e)
		external := filepath.Join(filepath.Dir(e), "external")
		write(t, external, "external")
		if err := os.Symlink(external, filepath.Join(src.Config, "redirect")); err != nil {
			t.Skip("host cannot create symlink", err)
		}
		if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err == nil {
			t.Fatal("linked file copied")
		}
		if read(t, external) != "external" || !exists(filepath.Join(src.Config, "settings.json")) {
			t.Fatal("source or external data deleted")
		}
	})
	t.Run("bad journal", func(t *testing.T) {
		e := exe(t)
		write(t, transactionPath(e), "{broken")
		if _, err := Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil); err == nil {
			t.Fatal("bad journal overwritten")
		}
		if read(t, transactionPath(e)) != "{broken" {
			t.Fatal("journal overwritten")
		}
	})
}

func TestPublishedRecoveryRechecksCopyBeforeCleanup(t *testing.T) {
	oldGrace := settleGrace
	settleGrace = 0
	t.Cleanup(func() { settleGrace = oldGrace })
	e := exe(t)
	src := installedData(t, e)
	dst, _ := PlacesOf(e, appdir.ModePortable)
	afterPublish = func() error {
		if err := appdir.WriteMode(e, appdir.ModePortable); err != nil {
			return err
		}
		write(t, filepath.Join(dst.Config, "settings.json"), "bad copy")
		panic("interruption after pointer")
	}
	t.Cleanup(func() { afterPublish = func() error { return nil } })
	func() { defer func() { recover() }(); _ = runMove(t, e, appdir.ModeInstalled, appdir.ModePortable) }()
	if err := Settle(e); err != nil {
		t.Fatal(err)
	}
	tx, _ := Status(e)
	if tx.State != StateCleanup || !strings.Contains(tx.Error, "differs") {
		t.Fatal("bad published copy accepted", tx)
	}
	if !exists(filepath.Join(src.Config, "settings.json")) {
		t.Fatal("source deleted without verification")
	}
	if mode, _ := appdir.ReadMode(e); mode != appdir.ModePortable {
		t.Fatal("committed pointer rolled back")
	}
}
