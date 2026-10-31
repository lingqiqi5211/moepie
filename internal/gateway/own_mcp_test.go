package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/gwtool"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

// The discovery endpoint is read-only, but keeps the existing network and
// caller-key guards. Knowing its path must not bypass sharing or revocation.
func TestOwnMCPKeepsGatewayAccess(t *testing.T) {
	fresh(t)
	toolsAre(t, 0)
	keys, secrets := newCaller(t, "MCP discovery")
	st := settings.Load()
	st.LAN = false
	if err := settings.Save(st); err != nil {
		t.Fatal(err)
	}
	h := lanGuard(New().Handler())
	ask := func(method, key string) int {
		r := httptest.NewRequest(method, OwnMCPPath, nil)
		r.RemoteAddr = "192.168.1.9:5000"
		if key != "" {
			r.Header.Set("Authorization", "Bearer "+key)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if got := ask("GET", secrets[0]); got != http.StatusForbidden {
		t.Fatalf("unshared: %d", got)
	}
	st = settings.Load()
	st.LAN = true
	if err := settings.Save(st); err != nil {
		t.Fatal(err)
	}
	if got := ask("GET", ""); got != http.StatusUnauthorized {
		t.Fatalf("missing key: %d", got)
	}
	if got := ask("GET", secrets[0]); got != http.StatusOK {
		t.Fatalf("enabled key: %d", got)
	}
	if got := ask("POST", secrets[0]); got == http.StatusOK {
		t.Fatal("POST should not list servers")
	}
	access.Update("off-key", access.Change{Key: keys[0].ID})
	if got := ask("GET", secrets[0]); got != http.StatusUnauthorized {
		t.Fatalf("revoked key: %d", got)
	}
}

// ownMCPNames asks the gateway for magpie's own MCP servers, as the chat
// page plugin does, and gives each one's name and path.
func ownMCPNames(t *testing.T, s *Server) map[string]string {
	t.Helper()
	r := httptest.NewRequest("GET", OwnMCPPath, nil)
	r.RemoteAddr = "127.0.0.1:50000"
	w := httptest.NewRecorder()
	lanGuard(s.Handler()).ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("%s: %d %s", OwnMCPPath, w.Code, w.Body)
	}
	var got struct {
		Servers []OwnMCP `json:"servers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Servers == nil {
		t.Fatalf("%s: %v %s", OwnMCPPath, err, w.Body)
	}
	out := map[string]string{}
	for _, m := range got.Servers {
		out[m.Name] = m.Path
	}
	return out
}

func toolsAre(t *testing.T, n int) {
	t.Helper()
	was := toolsOn
	toolsOn = func() (int, error) { return n, nil }
	t.Cleanup(func() { toolsOn = was })
}

// With nothing set up, none of magpie's own servers is listed, and the
// list is empty, not null.
func TestOwnMCPNoneWhenNothingIsOn(t *testing.T) {
	fresh(t)
	toolsAre(t, 0)
	if got := ownMCPNames(t, New()); len(got) != 0 {
		t.Fatalf("listed %v", got)
	}
}

// Image recognition is listed while a model sees, and not with it Off in
// Settings (ferock on Discord: the chat page gave a model the Library's
// servers only).
func TestOwnMCPListsVisionWhileOn(t *testing.T) {
	s, _ := eyed(t)
	toolsAre(t, 0)
	if got := ownMCPNames(t, s); got["magpie-vision"] != VisionMCPPath {
		t.Fatalf("vision on: %v", got)
	}
	noVision(t)
	if got := ownMCPNames(t, s); got["magpie-vision"] != "" {
		t.Fatalf("vision off: %v", got)
	}
}

// Image generation is listed while a model draws, and not with it Off.
func TestOwnMCPListsImageWhileOn(t *testing.T) {
	s, _ := easeled(t)
	toolsAre(t, 0)
	if got := ownMCPNames(t, s); got["magpie-image"] != ImageMCPPath {
		t.Fatalf("image on: %v", got)
	}
	st := settings.Load()
	st.ImageGen = "off"
	if err := settings.Save(st); err != nil {
		t.Fatal(err)
	}
	if got := ownMCPNames(t, s); got["magpie-image"] != "" {
		t.Fatalf("image off: %v", got)
	}
}

// Web search is listed while something searches and plugins/search
// serves, and not with the plugin off.
func TestOwnMCPListsSearchWhileOn(t *testing.T) {
	fresh(t)
	toolsAre(t, 0)
	apis := newSearchAPIs(t)
	if err := provider.SetSearchAPI(apis.api("tavily", "tvly-k")); err != nil {
		t.Fatal(err)
	}
	s := New()
	if got := ownMCPNames(t, s); got["magpie-web-search"] != SearchMCPPath {
		t.Fatalf("search on: %v", got)
	}
	stop := gwtool.Gate() // plugins/search off: nothing serves web_search
	defer stop()
	searchOn() // TestMain's
	defer func() { searchOn = gwtool.Serve(gwtool.WebSearch) }()
	if got := ownMCPNames(t, s); got["magpie-web-search"] != "" {
		t.Fatalf("plugins/search off: %v", got)
	}
}

// The plugin tools server is listed while plugins/tools serves and a
// plugin that is on gives a tool.
func TestOwnMCPListsPluginToolsWhileOn(t *testing.T) {
	fresh(t)
	s := New()
	toolsAre(t, 2)
	if got := ownMCPNames(t, s); got["magpie-tools"] != ToolsMCPPath {
		t.Fatalf("tools on: %v", got)
	}
	toolsAre(t, 0)
	if got := ownMCPNames(t, s); got["magpie-tools"] != "" {
		t.Fatalf("no plugin gives a tool: %v", got)
	}
	toolsAre(t, 2)
	stop := gwtool.Gate() // plugins/tools off
	defer stop()
	if got := ownMCPNames(t, s); got["magpie-tools"] != "" {
		t.Fatalf("plugins/tools off: %v", got)
	}
	defer gwtool.Serve(gwtool.PluginTools)()
	if got := ownMCPNames(t, s); got["magpie-tools"] != ToolsMCPPath {
		t.Fatalf("plugins/tools on: %v", got)
	}
}
