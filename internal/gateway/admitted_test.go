package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yetone/magpie/internal/datamove"
)

// A data move waiting for idle turns new work away and lets the rest on:
// reads and magpie's own calls; MCP, whose servers it stops, is refused
// without being counted, its streams held open for an agent's whole run.
func TestAdmittedWhileADataMoveWaits(t *testing.T) {
	datamove.Business.Close()
	t.Cleanup(datamove.Business.Open)
	h := (&Server{}).admitted(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for _, c := range []struct {
		method, path string
		code         int
	}{
		{"GET", "/v1/models", 200},
		{"POST", "/_magpie/claude-mcp/x", 200},
		{"POST", "/v1/chat/completions", http.StatusServiceUnavailable},
		{"POST", "/v1/messages", http.StatusServiceUnavailable},
		{"GET", "/mcp/magpie/hub", http.StatusServiceUnavailable},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
		if rec.Code != c.code {
			t.Errorf("%s %s: %d", c.method, c.path, rec.Code)
		}
	}
	datamove.Business.Open()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/mcp/magpie/hub", nil))
	if rec.Code != 200 {
		t.Errorf("MCP after the move gave up: %d", rec.Code)
	}
}
