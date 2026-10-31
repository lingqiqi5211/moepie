package gateway

import (
	"net/http"

	"github.com/yetone/magpie/internal/gwtool"
	"github.com/yetone/magpie/internal/plugin"
)

// OwnMCPPath lists the MCP servers magpie serves itself (web search,
// image recognition, image generation, the plugins' tools) that are on
// now, for an app that gives a model the Library's servers and wants
// magpie's own beside them: the community chat page (ferock on Discord),
// which read only library.json. A server is listed while an agent that
// mounts it would get its tools to work: the search while plugins/search
// serves and something searches (canSearch), image recognition while a
// model sees (seer: not Off in Settings), image generation while a model
// draws (drawer: not Off), the plugin tools while plugins/tools serves
// and a plugin that is on gives a tool. Each is named as its own
// initialize names it, with its path on this gateway; nothing in it is a
// secret.
const OwnMCPPath = "/v1/magpie/mcp"

// OwnMCP is one of magpie's own MCP servers, as OwnMCPPath lists it.
type OwnMCP struct {
	Name  string `json:"name"`
	Title string `json:"title"`
	Path  string `json:"path"` // on this gateway, Streamable HTTP
}

// toolsOn is how many plugins that are on give a tool, from the note the
// host keeps (never starting it); a variable for tests.
var toolsOn = plugin.ToolsOn

// ownMCP are magpie's own MCP servers that are on now.
func ownMCP() []OwnMCP {
	out := []OwnMCP{}
	if canSearch() {
		out = append(out, OwnMCP{"magpie-web-search", "Magpie Web Search", SearchMCPPath})
	}
	if _, ok := seer(); ok {
		out = append(out, OwnMCP{"magpie-vision", "Magpie Image Recognition", VisionMCPPath})
	}
	if _, ok := drawer(); ok {
		out = append(out, OwnMCP{"magpie-image", "Magpie Image", ImageMCPPath})
	}
	if gwtool.Served(gwtool.PluginTools) {
		// a note that can't be read says nothing: the server is listed,
		// and its tools/list tells
		if n, err := toolsOn(); err != nil || n > 0 {
			out = append(out, OwnMCP{"magpie-tools", "Magpie Plugin Tools", ToolsMCPPath})
		}
	}
	return out
}

func (s *Server) ownMCPList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"servers": ownMCP()})
}
