package datamove

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/yetone/magpie/internal/appdir"
)

func TestMovePreservesExternalSkillLink(t *testing.T) {
	e := exe(t)
	src := installedData(t, e)
	external, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(external, "SKILL.md")
	if err := os.WriteFile(marker, []byte("shared skill"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(src.Config, "library", "skills", "code-review")
	if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, link); err != nil {
		t.Skip("host cannot create symlink", err)
	}
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	dst, err := PlacesOf(e, appdir.ModePortable)
	if err != nil {
		t.Fatal(err)
	}
	copied := filepath.Join(dst.Config, "library", "skills", "code-review")
	target, err := os.Readlink(copied)
	if err != nil || target != external {
		t.Fatalf("link target %q: %v", target, err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("old link was not cleaned: %v", err)
	}
	if got := read(t, marker); got != "shared skill" {
		t.Fatalf("shared target changed: %q", got)
	}
	tx, err := Status(e)
	if err != nil || tx.State != StateComplete {
		t.Fatalf("incomplete migration: %+v, %v", tx, err)
	}
}

// Bun's install cache links its versions with links a move can't copy: it
// is left behind and taken out with the old cache folder.
func TestMoveSkipsBunInstallCache(t *testing.T) {
	e := exe(t)
	src := installedData(t, e)
	cache := filepath.Join(src.Cache, installCache)
	write(t, filepath.Join(cache, "pkg@1.0.0@@@1", "package.json"), "{}")
	link, target := filepath.Join(cache, "1.0.0@@@1"), filepath.Join(cache, "pkg@1.0.0@@@1")
	if runtime.GOOS == "windows" {
		// Bun's own kind of link there: a junction.
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			t.Fatalf("mklink: %v %s", err, out)
		}
	} else if err := os.Symlink("pkg@1.0.0@@@1", link); err != nil {
		t.Skip("host cannot create symlink", err)
	}
	write(t, filepath.Join(src.Cache, "bun", "state.json"), "s")
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	dst, err := PlacesOf(e, appdir.ModePortable)
	if err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(dst.Cache, installCache)) {
		t.Fatal("install cache was copied")
	}
	if read(t, filepath.Join(dst.Cache, "bun", "state.json")) != "s" {
		t.Fatal("rest of the cache was not copied")
	}
	if _, err := os.Lstat(filepath.Join(src.Cache, "bun")); !os.IsNotExist(err) {
		t.Fatalf("old install cache was not cleaned: %v", err)
	}
	if tx, err := Status(e); err != nil || tx.State != StateComplete {
		t.Fatalf("incomplete migration: %+v, %v", tx, err)
	}
}

func TestMoveRejectsLinksIntoOtherMigratingRoot(t *testing.T) {
	e := exe(t)
	src := installedData(t, e)
	if err := os.Symlink(src.Cache, filepath.Join(src.Config, "redirect")); err != nil {
		t.Skip("host cannot create symlink", err)
	}
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err == nil {
		t.Fatal("accepted link into migrating cache")
	}
	if got := read(t, filepath.Join(src.Config, "settings.json")); got != `{"a":1}` {
		t.Fatal("source changed")
	}
}

func TestCopyRejectsRelativeAndInternalLinks(t *testing.T) {
	for _, relative := range []bool{false, true} {
		t.Run(map[bool]string{false: "internal", true: "relative"}[relative], func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "target")
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
			if relative {
				target = "target"
			}
			if err := os.Symlink(target, filepath.Join(root, "link")); err != nil {
				t.Skip("host cannot create symlink", err)
			}
			if err := copyTree(context.Background(), root, t.TempDir(), func(string) bool { return false }); err == nil {
				t.Fatal("accepted unsafe link")
			}
		})
	}
}

func TestLinkManifestDetectsRetargetAndTypeChange(t *testing.T) {
	root, external, other := t.TempDir(), t.TempDir(), t.TempDir()
	path := filepath.Join(root, "link")
	if err := os.Symlink(external, path); err != nil {
		t.Skip("host cannot create symlink", err)
	}
	original, err := fileEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, path); err != nil {
		t.Fatal(err)
	}
	changed, err := fileEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	if sameEntry(original, changed) || sameData(map[string]entry{"link": original}, map[string]entry{"link": changed}) {
		t.Fatal("retarget not detected")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(external), 0600); err != nil {
		t.Fatal(err)
	}
	regular, err := fileEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	if sameEntry(original, regular) || sameData(map[string]entry{"link": original}, map[string]entry{"link": regular}) {
		t.Fatal("link replaced by target text was accepted")
	}
}
