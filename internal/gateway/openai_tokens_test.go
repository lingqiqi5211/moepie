package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func TestOpenAIChatCompletionTokens(t *testing.T) {
	for _, vendor := range []struct{ name, base, field string }{
		{"official", "https://api.openai.com/v1", "max_completion_tokens"},
		{"relay", "https://relay.example/v1", "max_tokens"},
	} {
		for _, client := range []struct{ name, path, body string }{
			{"chat", "/v1/chat/completions", `{"model":"token-test/gpt-6.1-sol","messages":[{"role":"user","content":"hi"}],"max_tokens":32}`},
			{"messages", "/v1/messages", `{"model":"token-test/gpt-6.1-sol","messages":[{"role":"user","content":"hi"}],"max_tokens":32}`},
		} {
			t.Run(vendor.name+"/"+client.name, func(t *testing.T) {
				fresh(t)
				if err := provider.Save(provider.Provider{ID: "token-test", Name: "Token test", Chat: vendor.base, Key: "synthetic-key", Models: []string{"gpt-6.1-sol"}}); err != nil {
					t.Fatal(err)
				}
				var path string
				var sent map[string]any
				s := New()
				s.client = &http.Client{Transport: countTransport(func(r *http.Request) (*http.Response, error) {
					defer r.Body.Close()
					path = r.URL.Path
					if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
						return nil, err
					}
					reply := `{"id":"c","object":"chat.completion","model":"gpt-6.1-sol","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`
					ct := "application/json"
					if sent["stream"] == true {
						ct = "text/event-stream"
						reply = "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-6.1-sol\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"}}]}\n\n" +
							"data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-6.1-sol\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
					}
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {ct}}, Request: r,
						Body: io.NopCloser(strings.NewReader(reply))}, nil
				})}
				rec := httptest.NewRecorder()
				s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", client.path, strings.NewReader(client.body)))
				if rec.Code != 200 || !strings.Contains(rec.Body.String(), "ok") {
					t.Fatalf("reply: %d %s", rec.Code, rec.Body)
				}
				if path != "/v1/chat/completions" || sent[vendor.field] != float64(32) {
					t.Fatalf("expected %s=32 at chat endpoint, got %s %v", vendor.field, path, sent)
				}
				other := "max_tokens"
				if vendor.field == other {
					other = "max_completion_tokens"
				}
				if _, ok := sent[other]; ok {
					t.Fatalf("unexpected %s in %v", other, sent)
				}
			})
		}
	}
}
