package cli

import "testing"

func TestNeedsData(t *testing.T) {
	for _, args := range [][]string{nil, {"mcp", "image"}, {"claude-mcp-helper"}, {"serve"}, {"web"}, {"tui"}, {"app"}, {"tool", "image"}, {"daemon", "start"}, {"data-directory", "status"}} {
		if !needsData(args) {
			t.Errorf("business entry bypasses startup: %v", args)
		}
	}
	for _, args := range [][]string{{"--help"}, {"version"}, {"serve", "--help"}, {"help"}} {
		if needsData(args) {
			t.Errorf("usage creates application files: %v", args)
		}
	}
}

// What an agent runs for its whole session takes no lease, which would keep
// a move waiting on it; whatever serves or writes magpie's data does.
func TestLeaseFree(t *testing.T) {
	for _, args := range [][]string{{"mcp", "image"}, {"claude-mcp-helper"}, {"statusline"}, {"tool", "image"}, {"healthcheck"}} {
		if !leaseFree(args) {
			t.Errorf("agent helper holds a lease: %v", args)
		}
	}
	for _, args := range [][]string{{"serve"}, {"web"}, {"tui"}, {"app"}, {"gui"}, {"daemon", "start"}} {
		if leaseFree(args) {
			t.Errorf("data writer starts without a lease: %v", args)
		}
	}
}

func TestWindowEntry(t *testing.T) {
	if !hasGUI {
		if windowEntry(nil) {
			t.Fatal("a build without a window shows a dialog")
		}
		return
	}
	for _, args := range [][]string{nil, {"app"}, {"gui", "settings"}, {"tray"}, {"magpie://open"}, {"-Embedding"}} {
		if !windowEntry(args) {
			t.Errorf("window start fails silently: %v", args)
		}
	}
	for _, args := range [][]string{{"serve"}, {"tui"}, {"mcp"}} {
		if windowEntry(args) {
			t.Errorf("terminal command shows a dialog: %v", args)
		}
	}
}
