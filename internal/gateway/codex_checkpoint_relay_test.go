package gateway

import (
	"net/http"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func TestCodexCheckpointPassesToSelectedResponsesRelay(t *testing.T) {
	for _, path := range []string{CodexPath + "/responses", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			f := &fake{t: t, reply: sse(`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`)}
			setup(t, provider.Responses, f)
			wroteCheckpoint("official-checkpoint", candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{Agent: "codex", User: "writer@example.com"}}})
			body := `{"model":"fake/m1","stream":true,"tools":[{"type":"web_search"}],"input":[{"type":"compaction","encrypted_content":"official-checkpoint"},{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]}`
			code, response := postTo(t, New(), path, body)
			if code != http.StatusOK || f.calls != 1 || !strings.Contains(string(f.got), `"encrypted_content":"official-checkpoint"`) {
				t.Fatalf("checkpoint not relayed intact: %d %s calls=%d body=%s", code, response, f.calls, f.got)
			}
			if strings.Contains(string(f.got), magpieCompaction) {
				t.Fatal("native checkpoint replaced with a summary")
			}
		})
	}
}

func TestCodexCheckpointRelayRefusalPreservesContext(t *testing.T) {
	f := &fake{t: t}
	f.refuse = func(body []byte) (int, string) {
		return http.StatusBadRequest, `{"error":{"message":"checkpoint is not readable by this upstream","type":"invalid_request_error"}}`
	}
	setup(t, provider.Responses, f)
	wroteCheckpoint("official-checkpoint", candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{Agent: "codex", User: "writer@example.com"}}})
	code, reply := codexPost(t, `{"model":"fake/m1","stream":true,"input":[{"type":"compaction","encrypted_content":"official-checkpoint"}]}`)
	if code != http.StatusBadRequest || !strings.Contains(reply, "checkpoint is not readable") || !strings.Contains(string(f.got), `"encrypted_content":"official-checkpoint"`) {
		t.Fatalf("upstream refusal not preserved: %d %s, sent %s", code, reply, f.got)
	}
}
