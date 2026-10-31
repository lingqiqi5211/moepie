package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/settings"
)

func TestOpenAIProbeProtocol(t *testing.T) {
	for _, c := range []struct {
		name, base string
		key, want  Protocol
		listed     []string
		picked     Protocol
	}{
		{name: "any-key", key: "", want: Responses},
		{name: "responses-key", key: Responses, want: Responses},
		{name: "chat-key", key: Chat, want: Chat},
		{name: "listed-chat", listed: []string{"chat"}, want: Chat},
		{name: "listed-both", listed: []string{"chat", "responses"}, want: Responses},
		{name: "picked-chat", picked: Chat, want: Chat},
		{name: "relay", base: "https://relay.example/v1", want: Chat},
	} {
		t.Run(c.name, func(t *testing.T) {
			detectHome(t)
			catalog.Reset()
			t.Cleanup(catalog.Reset)
			var path string
			rt := openCodeTransport(func(r *http.Request) (*http.Response, error) {
				path = r.URL.Path
				if r.Body != nil {
					io.Copy(io.Discard, r.Body)
					r.Body.Close()
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{}`)), Request: r}, nil
			})
			oldT, oldC := http.DefaultTransport, http.DefaultClient.Transport
			http.DefaultTransport, http.DefaultClient.Transport = rt, rt
			t.Cleanup(func() { http.DefaultTransport, http.DefaultClient.Transport = oldT, oldC })
			base := c.base
			if base == "" {
				base = "https://api.openai.com/v1"
			}
			const model = "gpt-6.1-sol"
			p := Provider{ID: "openai-probe", Chat: base, Responses: base, Key: "synthetic-key", KeyProtocol: c.key}
			if c.listed != nil {
				if err := catalog.SaveLive(p.ID, base, []catalog.Model{{ID: model, APIs: c.listed}}); err != nil {
					t.Fatal(err)
				}
			}
			if c.picked != "" {
				s := settings.Load()
				s.ModelAPIs = map[string]string{p.ID + "/" + model: string(c.picked)}
				if err := settings.Save(s); err != nil {
					t.Fatal(err)
				}
			}
			r := p.TestModels(context.Background(), []string{model})[0]
			wantPath := "/v1/responses"
			if c.want == Chat {
				wantPath = "/v1/chat/completions"
			}
			if !r.OK || r.Protocol != c.want || path != wantPath {
				t.Fatalf("expected %s probe at %s, got %+v path=%q", c.want, wantPath, r, path)
			}
		})
	}
}

func TestOpenAIChatProbeTokens(t *testing.T) {
	for _, c := range []struct {
		name, base, field string
	}{
		{"official", "https://api.openai.com/v1", "max_completion_tokens"},
		{"relay", "https://relay.example/v1", "max_tokens"},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, body := tinyBody(Provider{Chat: c.base}, Chat, "gpt-6.1-sol")
			var in map[string]any
			if err := json.Unmarshal([]byte(body), &in); err != nil {
				t.Fatal(err)
			}
			if in[c.field] != float64(16) {
				t.Fatalf("expected %s=16, got %s", c.field, body)
			}
			other := "max_tokens"
			if c.field == other {
				other = "max_completion_tokens"
			}
			if _, ok := in[other]; ok {
				t.Fatalf("unexpected %s in %s", other, body)
			}
		})
	}
}
