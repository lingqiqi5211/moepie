package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/tidwall/gjson"
	"github.com/yetone/magpie/internal/edit"
)

// portableVSCode lays VS Code out under home as a portable build is: its
// launcher in bin, and, when portable, its data folder beside the program —
// a zip's own, or Scoop's, whose apps\vscode\current\data is the persisted
// one (current a junction into apps\vscode, which a folder reads through
// the same). The launcher is put on PATH; with shims, a Scoop shim of it
// is, as scoop's shims folder has.
func portableVSCode(t *testing.T, home string, portable, shims bool) (user string) {
	t.Helper()
	app := filepath.Join(home, "Editor With Spaces")
	binDir := filepath.Join(app, "bin")
	if shims {
		app = filepath.Join(home, "scoop", "apps", "vscode", "current")
		binDir = filepath.Join(home, "scoop", "shims")
	}
	name := "code"
	if runtime.GOOS == "windows" {
		name += ".cmd"
		t.Setenv("PATHEXT", ".CMD")
	}
	writeAt(t, filepath.Join(app, "bin", name), "launcher\n")
	if err := os.Chmod(filepath.Join(app, "bin", name), 0o755); err != nil {
		t.Fatal(err)
	}
	if shims {
		writeAt(t, filepath.Join(binDir, name), "shim\n")
		if err := os.Chmod(filepath.Join(binDir, name), 0o755); err != nil {
			t.Fatal(err)
		}
		writeAt(t, filepath.Join(binDir, "code.shim"), "path = "+filepath.Join(app, "bin", name)+"\n")
	}
	if portable {
		if err := os.MkdirAll(filepath.Join(app, "data"), 0o755); err != nil {
			t.Fatal(err)
		}
		user = filepath.Join(app, "data", "user-data", "User")
	}
	t.Setenv("PATH", binDir)
	return user
}

// installedUserDir is the User folder of an installed VS Code, where the OS
// puts it.
func installedUserDir(home string) string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), "Code", "User")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Code", "User")
	}
	return filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "Code", "User")
}

// YOUIMARK's Windows has Scoop's VS Code, a portable build: magpie showed
// the editor, but its Dir stayed %APPDATA%\Code\User, which doesn't exist —
// code.cmd on PATH was detection enough — so its provider, models and
// settings.json went where the build never reads (#3260). A portable
// build's User folder is in its data folder: data\user-data\User beside the
// program. An installed build, whose launcher has no data folder beside it,
// keeps the OS's.
func TestVSCodePortableUserDir(t *testing.T) {
	home, cfg := syncHome(t), os.Getenv("XDG_CONFIG_HOME")
	// the launcher is taken through filepath.EvalSymlinks, which a Mac's
	// temporary folders come out of one symlink longer
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	}
	portableVSCode(t, home, false, false)
	if a := vscode(home, cfg); a.Dir != installedUserDir(home) {
		t.Fatalf("an installed build's User folder is %s, want %s", a.Dir, installedUserDir(home))
	}
	user := portableVSCode(t, home, true, false)
	a := vscode(home, cfg)
	if a.Dir != user {
		t.Fatalf("the portable build's User folder is %s, want %s", a.Dir, user)
	}
	// before its first run has made the folder, its launcher alone is
	// detection enough — and connecting writes there, where it reads
	if !a.Detected() {
		t.Fatal("the portable build isn't listed")
	}
	if err := a.Connect(); err != nil {
		t.Fatal(err)
	}
	lm := filepath.Join(a.Dir, "chatLanguageModels.json")
	if g, ok := edit.GetJSONItem(lm, vscodeGroup); !ok || gjson.Get(g, "models.0.id").String() != "relay/glm-4.6" {
		t.Fatalf("not wired in the data folder:\n%s", readFile(lm))
	}
	if err := a.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if _, ok := edit.GetJSONItem(lm, vscodeGroup); ok {
		t.Fatalf("disconnected, magpie's group kept:\n%s", readFile(lm))
	}
}

// Scoop's code.cmd is a shim: the launcher it stands for is named by the
// .shim beside it (proc.Unwrap doesn't read those), and the data folder is
// the persisted one. A shim of a launcher with no data folder beside it is
// an installed build; its steps run in that order, as a data folder made
// stays.
func TestVSCodePortableScoopShim(t *testing.T) {
	home, cfg := syncHome(t), os.Getenv("XDG_CONFIG_HOME")
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	}
	portableVSCode(t, home, false, true)
	if a := vscode(home, cfg); a.Dir != installedUserDir(home) {
		t.Fatalf("an installed build's User folder is %s, want %s", a.Dir, installedUserDir(home))
	}
	user := portableVSCode(t, home, true, true)
	if a := vscode(home, cfg); a.Dir != user {
		t.Fatalf("Scoop's portable VS Code reads %s, want %s", a.Dir, user)
	}
}
