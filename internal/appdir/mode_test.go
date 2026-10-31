package appdir

import (
	"os"
	"path/filepath"
	"testing"
)

// The mode file comes before Resolve's guess: a data folder left beside
// magpie after a move to the installed place isn't taken for its data, and
// a portable mode needs no data guess in a shared folder.
func TestModeFileComesFirst(t *testing.T) {
	t.Setenv("APPIMAGE", "")
	r := root(t)
	exe := touch(t, filepath.Join(r, "magpie"))
	data := filepath.Join(r, DataName)
	mkdir(t, data)
	touch(t, filepath.Join(data, "settings.json"))
	if Resolve(exe) != data {
		t.Fatalf("without a mode file the data folder is magpie's: %q", Resolve(exe))
	}
	if err := WriteMode(exe, ModeInstalled); err != nil {
		t.Fatal(err)
	}
	if got := Resolve(exe); got != "" {
		t.Fatalf("installed mode with a data folder left beside it resolved to %q", got)
	}
	if Passed(exe) != "" {
		t.Fatal("a data folder the mode file put aside was named as passed over")
	}
	if err := WriteMode(exe, ModePortable); err != nil {
		t.Fatal(err)
	}
	if got := Resolve(exe); got != data {
		t.Fatalf("portable mode resolved to %q, not %q", got, data)
	}
	if err := CheckMode(exe); err != nil {
		t.Fatal(err)
	}
}

// A portable mode whose data folder is gone, or a mode file magpie can't
// read, is an error, and resolves to the data folder: never to the
// installed accounts.
func TestModeFileBroken(t *testing.T) {
	t.Setenv("APPIMAGE", "")
	r := root(t)
	exe := touch(t, filepath.Join(r, "magpie"))
	if err := WriteMode(exe, ModePortable); err != nil {
		t.Fatal(err)
	}
	if CheckMode(exe) == nil {
		t.Fatal("portable mode with no data folder passed the check")
	}
	if err := os.WriteFile(ModePath(exe), []byte(`{"version":1,"mode":"elsewhere"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if CheckMode(exe) == nil {
		t.Fatal("an unknown mode passed the check")
	}
	if got := Resolve(exe); got != filepath.Join(r, DataName) {
		t.Fatalf("a broken mode file resolved to %q", got)
	}
}
