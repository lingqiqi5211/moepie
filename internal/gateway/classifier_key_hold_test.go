package gateway

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/provider"
)

// lunaBackend stands in for the ChatGPT backend, noting the account each
// request was sent on, and answers "1".
func lunaBackend(t *testing.T) func() []string {
	return lunaBackendRefusing(t, "")
}

// lunaBackendRefusing is lunaBackend answering 429 on the account refuse.
func lunaBackendRefusing(t *testing.T, refuse string) func() []string {
	t.Helper()
	var mu sync.Mutex
	var asked []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		if strings.HasSuffix(r.URL.Path, "/models") {
			io.WriteString(w, `{"models":[{"slug":"gpt-6-luna","visibility":"list"}]}`)
			return
		}
		mu.Lock()
		asked = append(asked, r.Header.Get("chatgpt-account-id"))
		mu.Unlock()
		if refuse != "" && r.Header.Get("chatgpt-account-id") == refuse {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(429)
			io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, sse(
			`data: {"type":"response.created","response":{"id":"r1","model":"gpt-6-luna"}}`,
			`data: {"type":"response.output_text.delta","delta":"1"}`,
			`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":7,"output_tokens":1}}}`))
	}))
	t.Cleanup(up.Close)
	was := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = was })
	p, err := provider.Find("codex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := slices.Clone(asked)
		asked = nil
		return out
	}
}

// A gateway key held to one account holds what the classifier is asked
// for its turns too, as it holds magpie's other calls for the key (a web
// search, a title): a ruled group whose classifier is a Codex model asks
// it on the key's account, as the turn itself is sent.
func TestClassifierModelHeldToTheKeysAccount(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	asked := lunaBackend(t)
	if err := provider.SaveGroup(provider.Group{Name: "R", Members: []string{"codex/gpt-6-luna", "codex/gpt-6-luna:high"}, Routing: provider.Ordered,
		Classifier: "codex/gpt-6-luna", Rules: []provider.Rule{{Use: "codex/gpt-6-luna:high", Intent: "feature"}}}); err != nil {
		t.Fatal(err)
	}
	s := New()
	keys, secrets := newCaller(t, "Held")
	if _, err := access.Update("accounts-key", access.Change{Key: keys[0].ID, Accounts: []string{"codex/spare@example.com"}}); err != nil {
		t.Fatal(err)
	}
	for i := range 3 {
		noRests()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"group/r","messages":[{"role":"user","content":"add feature `+fmt.Sprint(i)+`"}]}`))
		req.Header.Set("Authorization", "Bearer "+secrets[0])
		req.Header.Set("x-session-id", fmt.Sprint("k", i))
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("turn %d: %d %s", i, rec.Code, rec.Body.String())
		}
		a := asked()
		if len(a) < 2 {
			t.Fatalf("turn %d: %d requests reached the backend, not the classifier's and the turn's", i, len(a))
		}
		for _, a := range a {
			if a != "acct-2" {
				t.Fatalf("turn %d: the classifier was asked on %q, not the key's acct-2", i, a)
			}
		}
	}
}
