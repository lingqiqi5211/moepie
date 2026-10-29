package settings

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/filelock"
)

// Edits made at once each keep the others': each is made from what the
// file holds when it is made, not from a copy read before another saved.
func TestEditKeepsEachChange(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := Save(Settings{Theme: "dark"}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Go(func() {
			for i := range 20 {
				err := Edit(func(s *Settings) error {
					if s.UsageAliases == nil {
						s.UsageAliases = map[string]string{}
					}
					s.UsageAliases[fmt.Sprintf("m%d-%d", g, i)] = "x"
					return nil
				})
				if err != nil {
					t.Error(err)
				}
			}
		})
	}
	wg.Wait()
	s := Load()
	if len(s.UsageAliases) != 160 || s.Theme != "dark" {
		t.Fatalf("%d of 160 aliases kept, theme %q", len(s.UsageAliases), s.Theme)
	}
}

// An error from edit saves nothing.
func TestEditErrorSavesNothing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := Save(Settings{Theme: "dark"}); err != nil {
		t.Fatal(err)
	}
	no := errors.New("no")
	err := Edit(func(s *Settings) error { s.Theme = "light"; return no })
	if !errors.Is(err, no) || Load().Theme != "dark" {
		t.Fatalf("err %v, theme %q", err, Load().Theme)
	}
}

// Another magpie holding the settings past the wait: the save is refused,
// not written over its change.
func TestSaveRefusedWhileAnotherHolds(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := Save(Settings{Theme: "dark"}); err != nil {
		t.Fatal(err)
	}
	lockWait = 100 * time.Millisecond
	t.Cleanup(func() { lockWait = filelock.Wait })
	unlock, held := filelock.Lock(Path()+".lock", time.Second)
	if !held {
		t.Skip("no file locks here")
	}
	err := Edit(func(s *Settings) error { s.Theme = "light"; return nil })
	if !errors.Is(err, filelock.ErrHeld) {
		t.Fatalf("saved while another held it: %v", err)
	}
	unlock()
	if err := Edit(func(s *Settings) error { s.Theme = "light"; return nil }); err != nil || Load().Theme != "light" {
		t.Fatalf("after it let go: %v, theme %q", err, Load().Theme)
	}
}
