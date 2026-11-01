//go:build windows

package datamove

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/yetone/magpie/internal/appdir"
)

func TestStartThroughACurrentJunction(t *testing.T) {
	e := exe(t) // <root>/app/moepie.exe
	app := filepath.Dir(e)
	version := filepath.Join(app, "0.1.4")
	if err := os.MkdirAll(version, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(e, filepath.Join(version, "moepie.exe")); err != nil {
		t.Fatal(err)
	}
	current := filepath.Join(app, "current")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", current, version).CombinedOutput(); err != nil {
		t.Skipf("mklink /J: %v %s", err, out)
	}
	if err := os.MkdirAll(filepath.Join(version, "data"), 0o755); err != nil {
		t.Fatal(err)
	}

	exeViaCurrent := filepath.Join(current, "moepie.exe")
	appdir.UseExecutable(exeViaCurrent)
	t.Cleanup(func() { appdir.UseExecutable("") })

	lease, err := Start(exeViaCurrent)
	if err != nil {
		t.Fatalf("start through current: %v", err)
	}
	lease()

	if _, err := os.Stat(filepath.Join(version, "data", runtimeName, "gate")); err != nil {
		t.Fatalf("lease in the real data folder: %v", err)
	}
}
