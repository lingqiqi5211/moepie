package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func TestWholeRouteRetryableScope(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   bool
	}{
		{529, `{"error":{"message":"Site is overloaded"}}`, true},
		{502, `{"error":{"message":"read: EOF"}}`, true},
		{502, `{"error":{"message":"connection reset by peer"}}`, true},
		{502, `{"error":{"message":"request rejected"}}`, false},
		{429, `{"error":{"type":"usage_limit_reached"}}`, false},
		{401, `{"error":{"message":"unauthorized"}}`, false},
		{400, `{"error":{"message":"invalid request"}}`, false},
	} {
		if got := wholeRouteRetryable(tc.status, []byte(tc.body)); got != tc.want {
			t.Errorf("status=%d body=%s: %v, want %v", tc.status, tc.body, got, tc.want)
		}
	}
}

func TestCodexTransientPoolRetryIsBounded(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	old := singlePatience
	singlePatience = 0
	t.Cleanup(func() { singlePatience = old })
	var attempts atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		attempts.Add(1)
		w.WriteHeader(529)
		io.WriteString(w, `{"error":{"message":"Site is overloaded"}}`)
	}))
	t.Cleanup(up.Close)
	was := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = was })
	code, _ := codexPost(t, `{"model":"gpt-5.5","stream":true,"input":"ping"}`)
	if code != 529 || attempts.Load() != 8 {
		t.Fatalf("permanent overload: status=%d attempts=%d, want 529 and 8", code, attempts.Load())
	}
}

// When ChatGPT's front briefly drops every account's connection, Codex's
// request gets one fresh pass through the pool instead of needing Continue.
func TestCodexOwnModelRetriesPoolAfterTransientUpstreamFailure(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	old := singlePatience
	singlePatience = 0 // distinguish the extra pool pass from existing patience
	t.Cleanup(func() { singlePatience = old })
	var mu sync.Mutex
	var tried []string
	attempts := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		tried = append(tried, r.Header.Get("chatgpt-account-id"))
		attempts++
		if attempts <= 4 {
			w.WriteHeader(http.StatusBadGateway)
			io.WriteString(w, `{"error":{"message":"Post https://chatgpt.com/backend-api/codex/responses: EOF"}}`)
			return
		}
		io.WriteString(w, sse(
			`data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.5"}}`,
			`data: {"type":"response.output_text.delta","delta":"pong"}`,
			`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":7,"output_tokens":1}}}`))
	}))
	t.Cleanup(up.Close)
	was := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = was })

	code, body := codexPost(t, `{"model":"gpt-5.5","stream":true,"input":"ping"}`)
	if code != http.StatusOK || !strings.Contains(body, "pong") {
		t.Fatalf("status %d: %s; tried %v", code, body, tried)
	}
	mu.Lock()
	defer mu.Unlock()
	if attempts != 5 || strings.Join(tried, ",") != "acct-1,acct-2,acct-2,acct-2,acct-1" {
		t.Fatalf("attempts %d tried %v", attempts, tried)
	}
}

// A 529 means the upstream is overloaded, so it gets the same one fresh pool
// pass as a transport failure instead of ending the turn after every account.
func TestCodexOwnModelRetriesPoolAfterUpstreamOverload(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	old := singlePatience
	singlePatience = 0 // distinguish the extra pool pass from existing patience
	t.Cleanup(func() { singlePatience = old })
	var mu sync.Mutex
	var tried []string
	attempts := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		tried = append(tried, r.Header.Get("chatgpt-account-id"))
		attempts++
		if attempts <= 4 {
			w.WriteHeader(529)
			io.WriteString(w, `{"error":{"message":"Site is overloaded"}}`)
			return
		}
		io.WriteString(w, sse(
			`data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.5"}}`,
			`data: {"type":"response.output_text.delta","delta":"pong"}`,
			`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":7,"output_tokens":1}}}`))
	}))
	t.Cleanup(up.Close)
	was := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = was })

	code, body := codexPost(t, `{"model":"gpt-5.5","stream":true,"input":"ping"}`)
	if code != http.StatusOK || !strings.Contains(body, "pong") {
		t.Fatalf("status %d: %s; tried %v", code, body, tried)
	}
	mu.Lock()
	defer mu.Unlock()
	if attempts != 5 || strings.Join(tried, ",") != "acct-1,acct-2,acct-2,acct-2,acct-1" {
		t.Fatalf("attempts %d tried %v", attempts, tried)
	}
}
