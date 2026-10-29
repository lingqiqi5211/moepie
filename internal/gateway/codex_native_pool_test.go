package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// Keep an official checkpoint through a quota failover and a second
// compaction; the gateway must never substitute its summary. This local
// regression uses a fake backend, not a live account.
func TestCodexNativeCompactionPoolFailover(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	nativeOn(t, "codex")
	if err := provider.SetRouting("codex", provider.Ordered); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var received []string
	compacted := false
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/backend-api/codex/responses" {
			w.WriteHeader(404)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		who := r.Header.Get("chatgpt-account-id")
		received = append(received, who+" "+string(body))
		if who == "acct-1" && compacted {
			w.WriteHeader(429)
			io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":7200}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if compactionTriggerIn(body) {
			compacted = true
			io.WriteString(w, nativeSealedReply("checkpoint-"+who))
			return
		}
		io.WriteString(w, sse(`data: {"type":"response.completed","response":{"id":"r1","output":[],"usage":{"input_tokens":9,"output_tokens":1}}}`))
	}))
	t.Cleanup(up.Close)
	was := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = was })
	if code, body := nativeAsk(t, "codex/gpt-5.5", compactTurn); code != 200 || !strings.Contains(body, "checkpoint-acct-1") {
		t.Fatalf("compact: %d %s", code, body)
	}
	body := `{"model":"codex/gpt-5.5","stream":true,"input":[{"type":"compaction","encrypted_content":"checkpoint-acct-1"},{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]}`
	if code, reply := codexPost(t, body); code != 200 {
		t.Fatalf("quota failover: %d %s", code, reply)
	}
	mu.Lock()
	got := append([]string(nil), received...)
	mu.Unlock()
	if len(got) != 3 || !strings.HasPrefix(got[1], "acct-1 ") || !strings.HasPrefix(got[2], "acct-2 ") || !strings.Contains(got[2], `"encrypted_content":"checkpoint-acct-1"`) {
		t.Fatalf("checkpoint was not retained across the account switch: %q", got)
	}
	body = `{"model":"codex/gpt-5.5","stream":true,"input":[{"type":"compaction","encrypted_content":"checkpoint-acct-1"},{"type":"compaction_trigger"}]}`
	if code, reply := codexPost(t, body); code != 200 || !strings.Contains(reply, "checkpoint-acct-2") || strings.Contains(reply, magpieCompaction) {
		t.Fatalf("recompact on spare: %d %s", code, reply)
	}
	body = `{"model":"codex/gpt-5.5","stream":true,"input":[{"type":"compaction","encrypted_content":"checkpoint-acct-2"},{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]}`
	if code, reply := codexPost(t, body); code != 200 {
		t.Fatalf("after second compaction: %d %s", code, reply)
	}
}

func TestCodexNativeCompactionPoolRejectsChatOnlyProviders(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	var mu sync.Mutex
	calls := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		t.Error("a Chat-only provider received a Codex checkpoint")
		w.WriteHeader(400)
	}))
	t.Cleanup(up.Close)
	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "sk-relay", Chat: up.URL + "/v1", Models: []string{"m1"}}); err != nil {
		t.Fatal(err)
	}
	wroteCheckpoint("checkpoint-codex", candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{User: "me@example.com"}}})
	code, body := codexPost(t, `{"model":"relay/m1","stream":true,"input":[{"type":"compaction","encrypted_content":"checkpoint-codex"}]}`)
	if code != 400 || !strings.Contains(body, "no allowed Responses endpoint") {
		t.Fatalf("%d %s", code, body)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("unrelated provider called %d times", calls)
	}
}
