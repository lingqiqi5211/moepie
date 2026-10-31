package appdir

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ModeName is the file beside magpie (Beside) that says which of its two
// places its data is in, written by a data move. It is outside the data it
// names and comes before Resolve's guess: a data folder left beside magpie
// after a move to the installed place is not taken for its data again.
// Without it Resolve decides, as before.
const ModeName = "moepie-data.json"

// The two places: the user's config folder, or the data folder beside
// magpie.
const (
	ModeInstalled = "installed"
	ModePortable  = "portable"
)

type modeFile struct {
	Version int    `json:"version"`
	Mode    string `json:"mode"`
}

// ModePath is the mode file of a magpie run from exe.
func ModePath(exe string) string {
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return filepath.Join(Beside(exe), ModeName)
}

// ReadMode is the mode exe's mode file names, or "" with none. A file that
// can't be read or names neither mode is an error: magpie then opens
// neither place rather than guess.
func ReadMode(exe string) (string, error) {
	b, err := os.ReadFile(ModePath(exe))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("data directory mode: %w", err)
	}
	var m modeFile
	if json.Unmarshal(b, &m) != nil || m.Version != 1 || (m.Mode != ModeInstalled && m.Mode != ModePortable) {
		return "", fmt.Errorf("data directory mode %s: not a version 1 mode file", ModePath(exe))
	}
	return m.Mode, nil
}

// WriteMode switches exe's data to mode's place, in one rename.
func WriteMode(exe, mode string) error {
	b, _ := json.Marshal(modeFile{Version: 1, Mode: mode})
	path := ModePath(exe)
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// PortableData is the data folder a portable magpie run from exe uses.
func PortableData(exe string) string {
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return absolute(filepath.Join(Beside(exe), DataName))
}

// Installed is the folder an installed magpie keeps its files in.
func Installed() string { return installed() }

// CheckMode says why magpie run from exe can't open its data: a mode file
// it can't read, or one naming a portable data folder that is gone. Main
// shows it rather than open an empty or stale set of accounts.
func CheckMode(exe string) error {
	mode, err := ReadMode(exe)
	if err != nil || mode != ModePortable {
		return err
	}
	data := PortableData(exe)
	if fi, err := os.Stat(data); err != nil || !fi.IsDir() {
		return fmt.Errorf("%s says magpie's data is beside it, but %s is missing", ModePath(exe), data)
	}
	return nil
}
