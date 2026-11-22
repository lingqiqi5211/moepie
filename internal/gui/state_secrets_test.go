package gui

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/settings"
)

// /api/state's settings, polled after nearly every click, carry none of
// the credentials /api/settings keeps on disk: the old LAN key and the
// GitHub token. Neither does the last state served at start (?last=1),
// which has today's settings.
func TestStateSendsNoCredentials(t *testing.T) {
	sandboxHome(t)
	forgetLastState()
	t.Cleanup(forgetLastState)
	const lan, gh = "sk-magpie-statelanstatelanstatelan0123", "ghp_statetokenstatetoken0123"
	h := Handler(nil, nil)
	call := func(method, path, body string) string {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		if rec.Code != 200 {
			t.Fatalf("%s %d %s", path, rec.Code, rec.Body)
		}
		return rec.Body.String()
	}
	s := settings.Load()
	s.LANKey, s.GitHubToken = lan, gh
	if err := settings.Save(s); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/state", "/api/state?last=1"} {
		body := call("GET", path, "")
		if path == "/api/state?last=1" && body == "null\n" {
			t.Fatal("no state was kept for the next start")
		}
		for _, secret := range []string{lan, gh} {
			if strings.Contains(body, secret) {
				t.Errorf("%s carries %q", path, secret)
			}
		}
	}
	if s := settings.Load(); s.LANKey != lan || s.GitHubToken != gh {
		t.Fatal("the credentials on disk were changed")
	}
}
