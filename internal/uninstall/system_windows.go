package uninstall

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/yetone/magpie/internal/appdir"
)

const schemeKey = `Software\Classes\magpie`

// unregisterScheme takes out the magpie:// handler the app registered
// while it opens exe, or an exe that is gone.
func unregisterScheme(exe string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, schemeKey+`\shell\open\command`, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	v, _, _ := k.GetStringValue("")
	k.Close()
	if run, _, ok := strings.Cut(strings.TrimPrefix(v, `"`), `"`); ok && !strings.EqualFold(filepath.Clean(run), filepath.Clean(exe)) {
		if _, err := os.Stat(run); err == nil {
			return nil // another magpie's
		}
	}
	for _, sub := range []string{`\shell\open\command`, `\shell\open`, `\shell`, `\DefaultIcon`, ``} {
		if err := registry.DeleteKey(registry.CURRENT_USER, schemeKey+sub); err != nil && err != registry.ErrNotExist {
			return err
		}
	}
	return nil
}

// webData is WebView2's profile of an installed magpie: %APPDATA%\<exe
// name> (portable, it is in the data folder already).
func webData() []string {
	if appdir.Portable() != "" {
		return nil
	}
	exe, err := os.Executable()
	a := appdir.Getenv("APPDATA")
	if err != nil || a == "" {
		return nil
	}
	p := filepath.Join(a, filepath.Base(exe))
	// only a folder WebView2 made: its EBWebView inside
	if _, err := os.Stat(filepath.Join(p, "EBWebView")); err != nil {
		return nil
	}
	return []string{p}
}
