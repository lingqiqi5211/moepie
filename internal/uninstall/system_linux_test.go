package uninstall

import (
	"os"
	"path/filepath"
	"testing"
)

// uninstall takes out the menu entry the app made for magpie:// links, and
// the icon beside it, and leaves another magpie's alone: the entry names
// the executable it runs, and one still on disk is not the one uninstalling.
func TestUnregisterScheme(t *testing.T) {
	for _, tc := range []struct {
		name  string
		other bool // the entry runs another magpie, still installed
	}{
		{"this executable's entry", false},
		{"another magpie's entry", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := t.TempDir()
			t.Setenv("XDG_DATA_HOME", data)
			apps := filepath.Join(data, "applications")
			icons := filepath.Join(data, "icons", "hicolor", "256x256", "apps")
			for _, d := range []string{apps, icons} {
				if err := os.MkdirAll(d, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			uninstalling := filepath.Join(data, "moepie")
			entryExe := uninstalling
			if tc.other {
				// installed elsewhere and still there: that magpie's entry,
				// its icon, and the one an older moepie left, all stay
				entryExe = filepath.Join(data, "bin", "moepie")
				if err := os.MkdirAll(filepath.Dir(entryExe), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(entryExe, []byte("moepie"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			files := map[string]string{
				filepath.Join(apps, "moepie.desktop"): "[Desktop Entry]\nType=Application\nExec=" + entryExe +
					" %u\nIcon=moepie\nMimeType=x-scheme-handler/magpie;\nTerminal=false\n",
				filepath.Join(icons, "moepie.png"): "png",
				filepath.Join(icons, "magpie.png"): "png", // an older moepie's
			}
			for p, body := range files {
				if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := unregisterScheme(uninstalling); err != nil {
				t.Fatal(err)
			}
			for p := range files {
				_, err := os.Stat(p)
				if gone := os.IsNotExist(err); gone != !tc.other {
					t.Fatalf("%s: gone %v, want %v (%v)", filepath.Base(p), gone, !tc.other, err)
				}
			}
		})
	}
}
