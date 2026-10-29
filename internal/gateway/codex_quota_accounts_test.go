package gateway

import (
	"encoding/base64"
	"encoding/json"
	"github.com/yetone/magpie/internal/provider"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func addCodexSavedAccount(t *testing.T, email, acct string) {
	t.Helper()
	claims := func(m map[string]any) string {
		b, _ := json.Marshal(m)
		return "h." + base64.RawURLEncoding.EncodeToString(b) + ".s"
	}
	auth := map[string]any{"auth_mode": "chatgpt", "tokens": map[string]any{
		"id_token":      claims(map[string]any{"email": email}),
		"access_token":  claims(map[string]any{"exp": time.Now().Add(time.Hour).Unix(), "who": acct}),
		"refresh_token": "r-" + acct, "account_id": acct}}
	path := filepath.Join(filepath.Dir(provider.Path()), "logins.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var logins []map[string]any
	if err := json.Unmarshal(b, &logins); err != nil {
		t.Fatal(err)
	}
	logins = append(logins, map[string]any{"agent": "codex", "user": email, "on": true, "seen": time.Now(), "auth": auth})
	b, err = json.Marshal(logins)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	provider.ForgetAccounts()
	if err := provider.SetLoginOn("codex", email, true); err != nil {
		t.Fatal(err)
	}
}

// When every Codex account is out of its current window, the live Responses
// request waits for the first reset and retries the pool by itself.
func TestCodexOwnModelResumesAfterQuotaReset(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	oldQuotaResume := codexQuotaResumeMax
	codexQuotaResumeMax = 2 * time.Second
	t.Cleanup(func() { codexQuotaResumeMax = oldQuotaResume })
	var tried []string
	attempts := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		tried = append(tried, r.Header.Get("chatgpt-account-id"))
		attempts++
		if attempts <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":1}}`)
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
	if attempts != 3 || strings.Join(tried, ",") != "acct-1,acct-2,acct-1" {
		t.Fatalf("attempts %d tried %v", attempts, tried)
	}
}

// An account turned on while an all-quota request is waiting is picked up by
// that same request instead of requiring Continue or a second turn.
func TestCodexOwnModelResumesAfterAccountAdded(t *testing.T) {
	var added sync.WaitGroup
	t.Cleanup(added.Wait)
	codexSignedIn(t, "spare@example.com")
	oldQuotaResume := codexQuotaResumeMax
	codexQuotaResumeMax = 2 * time.Second
	t.Cleanup(func() { codexQuotaResumeMax = oldQuotaResume })
	var tried []string
	attempts := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		account := r.Header.Get("chatgpt-account-id")
		tried = append(tried, account)
		attempts++
		if attempts == 2 {
			added.Add(1)
			go func() {
				defer added.Done()
				time.Sleep(100 * time.Millisecond)
				addCodexSavedAccount(t, "new@example.com", "acct-3")
			}()
		}
		if attempts <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":1}}`)
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
	if strings.Join(tried, ",") != "acct-1,acct-2,acct-3" {
		t.Fatalf("tried %v", tried)
	}
}
