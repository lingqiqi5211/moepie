package davsync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"github.com/yetone/magpie/internal/backup"
)

// A real encrypted DAV exchange, with one transient failure injected only
// on the unconditional GET after a successful conditional 304.
func ownBoundaryFixture(t *testing.T) (*fakeDAV, Config, *atomic.Bool) {
	t.Helper()
	f := &fakeDAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true}, cond: true, putETag: true}
	fail := new(atomic.Bool)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.Header.Get("If-None-Match") == "" && fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		f.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	newComputer(t).use(t)
	codexPick(t, "gpt-shared", "low")
	if m, _ := codexHere(); m != "gpt-shared" {
		t.Fatalf("fixture Codex unavailable: %q", m)
	}
	c := Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "fixture-own-passphrase", Agents: true}
	if err := Configure(c); err != nil {
		t.Fatal(err)
	}
	if err := Now(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := loadState()
	st.Own = map[string]bool{"codex.model": true}
	saveState(st)
	return f, c, fail
}

func TestOwnEmptyServerKeepsLocalFieldsPrivate(t *testing.T) {
	f, c, _ := ownBoundaryFixture(t)
	codexPick(t, "gpt-private", "low")
	c.URL += "other/"
	if err := Configure(c); err != nil {
		t.Fatal(err)
	}
	if err := Now(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	data := append([]byte(nil), f.files["/dav/other/magpie/magpie.magpie-backup"]...)
	f.mu.Unlock()
	b, err := backup.Open(data, c.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := b.Agents["codex.model"]; ok {
		t.Fatalf("own model uploaded to empty server: %q", v)
	}
	if m, _ := codexHere(); m != "gpt-private" {
		t.Fatalf("local model changed: %q", m)
	}
	if !loadState().Own["codex.model"] {
		t.Fatal("ownership lost on server change")
	}
}

func TestOwnFollowRetriesAfterMissingCacheReadFailure(t *testing.T) {
	f, _, fail := ownBoundaryFixture(t)
	codexPick(t, "gpt-private", "low")
	if err := os.Remove(path(cacheName)); err != nil {
		t.Fatal(err)
	}
	fail.Store(true)
	if err := Follow(context.Background()); err == nil {
		t.Fatal("expected second GET failure")
	}
	f.mu.Lock()
	conditional := f.notModified
	f.mu.Unlock()
	if conditional == 0 {
		t.Fatal("fixture never reached conditional 304")
	}
	st := loadState()
	if !st.Follow || !st.Own["codex.model"] {
		t.Fatalf("pending Follow lost before application: follow=%v own=%v", st.Follow, st.Own)
	}
	fail.Store(false)
	if err := Now(context.Background()); err != nil {
		t.Fatal(err)
	}
	if m, _ := codexHere(); m != "gpt-shared" {
		t.Fatalf("retry did not follow server: %q", m)
	}
	st = loadState()
	if st.Follow || len(st.Own) != 0 {
		t.Fatalf("successful Follow stayed pending: follow=%v own=%v", st.Follow, st.Own)
	}
}

func TestOwnRestoreEqualAgentsResumesFollowing(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		name := "agents-off"
		if enabled {
			name = "agents-on"
		}
		t.Run(name, func(t *testing.T) {
			f, c, _ := ownBoundaryFixture(t)
			c.Agents = enabled
			if err := Configure(c); err != nil {
				t.Fatal(err)
			}
			if _, err := Restore(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := loadState().Own["codex.model"]; got == enabled {
				t.Fatalf("equal-value restore ownership=%v, agents=%v", got, enabled)
			}
			if !enabled {
				return
			}
			const at = "/dav/magpie/magpie.magpie-backup"
			f.mu.Lock()
			data := append([]byte(nil), f.files[at]...)
			f.mu.Unlock()
			b, err := backup.Open(data, c.Passphrase)
			if err != nil {
				t.Fatal(err)
			}
			b.Agents["codex.model"] = "gpt-later"
			data, err = backup.Seal(b, c.Passphrase)
			if err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.files[at], f.etags[at] = data, `"later"`
			f.mu.Unlock()
			if err := Now(context.Background()); err != nil {
				t.Fatal(err)
			}
			if m, _ := codexHere(); m != "gpt-later" {
				t.Fatalf("restore did not resume following: %q", m)
			}
		})
	}
}
