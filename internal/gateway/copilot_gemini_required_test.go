package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/provider"
)

// Copilot's Gemini answers 400 "invalid request body" to a tool schema whose
// required names a property it lacks, and to two tools of one name
// (yuushabu_buyinn on X). The fake refuses exactly those; the turn must
// reach it fit, and a clean tool must go as it came.
func TestCopilotGeminiTakesToolsFit(t *testing.T) {
	var mu sync.Mutex
	var sent []string
	copilotTurnFake(t, map[string]string{
		"gemini-3.8-flash": `["/chat/completions"]`,
	}, nil, func(m string, b []byte) bool {
		s := string(b)
		return strings.Contains(s, `"required":["ghost"`) || strings.Contains(s, `"required":["deep"]`) ||
			strings.Count(s, `"name":"dup"`) > 1
	}, "invalid request body", http.StatusBadRequest, &sent)

	req := `{"model":"copilot/gemini-3.8-flash","stream":false,
	"messages":[{"role":"user","content":"hi"}],
	"tools":[
	 {"type":"function","function":{"name":"dup","parameters":{"type":"object","properties":{"a":{"type":"string"}},"required":["ghost","a"]}}},
	 {"type":"function","function":{"name":"dup","parameters":{"type":"object","properties":{}}}},
	 {"type":"function","function":{"name":"nest","parameters":{"type":"object","properties":{"o":{"type":"object","properties":{"x":{"type":"string"}},"required":["deep"]}},"required":["o"]}}}]}`
	rec := httptest.NewRecorder()
	New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(req)))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 {
		t.Fatalf("Copilot was asked %d times", len(sent))
	}
	if !strings.Contains(sent[0], `"required":["a"]`) || !strings.Contains(sent[0], `"required":["o"]`) {
		t.Errorf("the real required entries were lost: %s", sent[0])
	}
}

func copilotTurnFake(t *testing.T, models map[string]string, refuse func(model string, body []byte) (int, string),
	chatRefuse func(model string, body []byte) bool, chatMessage string, chatStatus int, sent *[]string,
) {
	t.Helper()
	fresh(t)
	cfg := os.Getenv("XDG_CONFIG_HOME")
	os.MkdirAll(filepath.Join(cfg, "github-copilot"), 0o755)
	os.WriteFile(filepath.Join(cfg, "github-copilot", "apps.json"), mustJSON(map[string]any{
		"github.com:Iv1.x": map[string]any{"user": "echo", "oauth_token": "gho_echo"},
	}), 0o600)

	var mu sync.Mutex
	note := func(m string, b []byte) {
		mu.Lock()
		*sent = append(*sent, m+" "+string(b))
		mu.Unlock()
	}
	// the account's model list, as Copilot's would have it: each model on
	// the APIs its endpoints give
	var live []catalog.Model
	for id, endpoints := range models {
		var apis []string
		for _, e := range strings.Split(strings.Trim(strings.ReplaceAll(endpoints, "/v1/messages", "/chat/completions"), `[]"`), ",") {
			switch strings.TrimSpace(e) {
			case "/responses":
				apis = append(apis, "responses")
			default:
				apis = append(apis, "chat")
			}
		}
		live = append(live, catalog.Model{ID: id, Name: id, APIs: apis, Efforts: []string{"low", "medium", "high"}})
	}
	if err := catalog.SaveLive("copilot", "https://api.githubcopilot.com", live); err != nil {
		t.Fatalf("save live: %v", err)
	}
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/models":
			io.WriteString(w, `{"data":[]}`)
		case "/responses":
			m := modelOf(b)
			if refuse != nil {
				if status, message := refuse(m, b); status != 0 {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(status)
					io.WriteString(w, message)
					return
				}
			}
			note(m, b)
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, sse(
				`data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
				`data: {"type":"response.output_text.delta","delta":"DONE"}`,
				`data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":1}}}`))
		case "/chat/completions":
			m := modelOf(b)
			if chatRefuse != nil && chatRefuse(m, b) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(chatStatus)
				io.WriteString(w, `{"error":{"code":null,"message":"`+chatMessage+`","param":null,"type":"invalid_request_error"}}`)
				return
			}
			note(m, b)
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, sse(
				`data: {"id":"c1","model":"`+m+`","choices":[{"delta":{"content":"hi"}}]}`,
				`data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}`,
				`data: [DONE]`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(apiSrv.Close)
	ghSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/token") {
			json.NewEncoder(w).Encode(map[string]any{"token": "sess", "expires_at": time.Now().Add(time.Hour).Unix(), "endpoints": map[string]string{"api": apiSrv.URL}})
			return
		}
		io.WriteString(w, `{"copilot_plan":"individual"}`)
	}))
	t.Cleanup(ghSrv.Close)
	oldTok, oldUser := provider.CopilotTokenURL, provider.CopilotUserURL
	provider.CopilotTokenURL, provider.CopilotUserURL = ghSrv.URL+"/token", ghSrv.URL+"/user"
	t.Cleanup(func() { provider.CopilotTokenURL, provider.CopilotUserURL = oldTok, oldUser })
}
