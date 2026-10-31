package datamove

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/testenv"
)

func TestMain(m *testing.M) { testenv.Main(m) }

// exe is a magpie in a folder of its own, in the test's isolated home.
func exe(t *testing.T) string {
	t.Helper()
	t.Setenv("APPIMAGE", "")
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	e := filepath.Join(dir, "app", "moepie.exe")
	write(t, e, "binary")
	return e
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(path string) bool { _, err := os.Lstat(path); return err == nil }

// The two places' folders map one onto the other, config to config, cache
// to cache, profile to profile, both ways.
func TestPairsMapTheTwoPlaces(t *testing.T) {
	e := exe(t)
	data := filepath.Join(filepath.Dir(e), "data")
	home := os.Getenv("HOME")
	installed := []Pair{
		{From: filepath.Join(home, ".config", "magpie"), To: data},
		{From: filepath.Join(home, ".cache", "magpie"), To: filepath.Join(data, "cache")},
	}
	sys, err := appdir.InstalledSystemCache()
	if err != nil {
		t.Fatal(err)
	}
	if !appdir.SameCachePath(sys, appdir.InstalledCache()) {
		installed = append(installed, Pair{From: sys, To: filepath.Join(data, "system-cache")})
	}
	if runtime.GOOS == "windows" {
		installed = append(installed, Pair{From: filepath.Join(home, "AppData", "Roaming", "moepie.exe"), To: filepath.Join(data, "webview2"), Web: true})
	}
	got, err := Pairs(e, appdir.ModeInstalled, appdir.ModePortable)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, installed) {
		t.Fatalf("installed to portable:\n got %v\nwant %v", got, installed)
	}
	got, err = Pairs(e, appdir.ModePortable, appdir.ModeInstalled)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range installed {
		if got[i] != (Pair{From: p.To, To: p.From, Web: p.Web}) {
			t.Fatalf("portable to installed %d: %v", i, got[i])
		}
	}
}

// WebSkip leaves out what Chromium makes again, never the pages' storage.
func TestWebSkipKeepsStorage(t *testing.T) {
	for _, keep := range []string{"Local Storage", "IndexedDB", "Cookies", "Local State", "Preferences", "Network", "Session Storage", "Default"} {
		if slices.Contains(WebSkip, keep) {
			t.Fatalf("WebSkip leaves out %s", keep)
		}
	}
	for _, skip := range []string{"Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "GPUPersistentCache", "Crashpad", "BrowserMetrics", "lockfile"} {
		if !slices.Contains(WebSkip, skip) {
			t.Fatalf("WebSkip keeps %s", skip)
		}
	}
	tx := &Transaction{Pairs: []Pair{{From: "/a", To: "/b", Web: true}}}
	skip := skipper(tx, tx.Pairs[0], from)
	for rel, want := range map[string]bool{
		filepath.Join("EBWebView", "Default", "Cache"):         true,
		filepath.Join("EBWebView", "Default", "Code Cache"):    true,
		filepath.Join("EBWebView", "GrShaderCache"):            true,
		filepath.Join("EBWebView", "lockfile"):                 true,
		filepath.Join("EBWebView", "Default", "Local Storage"): false,
		filepath.Join("EBWebView", "Default", "IndexedDB"):     false,
		filepath.Join("EBWebView", "Local State"):              false,
	} {
		if skip(rel) != want {
			t.Fatalf("skip(%s) = %v", rel, !want)
		}
	}
}

// installedData writes an installed magpie's files: settings, a cache, a
// profile with storage and caches, and the runtime folder.
func installedData(t *testing.T, e string) Places {
	t.Helper()
	p, err := PlacesOf(e, appdir.ModeInstalled)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(p.Config, "settings.json"), `{"a":1}`)
	write(t, filepath.Join(p.Config, "logs", "usage.jsonl"), "u")
	write(t, filepath.Join(p.Config, runtimeName, "run-x"), "")
	write(t, filepath.Join(p.Cache, "models.json"), "m")
	if p.Web != "" {
		write(t, filepath.Join(p.Web, "EBWebView", "Default", "Local Storage", "leveldb", "1.ldb"), "ls")
		write(t, filepath.Join(p.Web, "EBWebView", "Default", "Cache", "Cache_Data", "f"), "c")
		write(t, filepath.Join(p.Web, "EBWebView", "Local State"), "{}")
	}
	return p
}

func runMove(t *testing.T, e, from, to string) error {
	t.Helper()
	tx, err := Prepare(e, from, to, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := Authorize(context.Background(), e, tx.ID); err != nil {
		t.Fatal(err)
	}
	return Run(context.Background(), e)
}

// A move to the portable place copies everything but caches the browser
// makes again, writes the mode file, removes verified source files, and closes
// the old place to a magpie still pointed at it.
func TestMoveToPortable(t *testing.T) {
	e := exe(t)
	src := installedData(t, e)
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	dst, _ := PlacesOf(e, appdir.ModePortable)
	if read(t, filepath.Join(dst.Config, "settings.json")) != `{"a":1}` || read(t, filepath.Join(dst.Cache, "models.json")) != "m" {
		t.Fatal("files didn't move")
	}
	if exists(filepath.Join(dst.Config, runtimeName, stageOwner)) || exists(filepath.Join(dst.Config, runtimeName, "run-x")) {
		t.Fatal("the runtime folder was copied")
	}
	if dst.Web != "" {
		if read(t, filepath.Join(dst.Web, "EBWebView", "Default", "Local Storage", "leveldb", "1.ldb")) != "ls" {
			t.Fatal("the pages' storage didn't move")
		}
		if exists(filepath.Join(dst.Web, "EBWebView", "Default", "Cache")) {
			t.Fatal("the browser's cache moved")
		}
	}
	if m, _ := appdir.ReadMode(e); m != appdir.ModePortable {
		t.Fatalf("mode file says %q", m)
	}
	if exists(filepath.Join(src.Config, "settings.json")) || exists(filepath.Join(src.Cache, "models.json")) {
		t.Fatal("verified source data was not removed")
	}
	if _, err := Enter(context.Background(), []string{src.Config}); err == nil || !strings.Contains(err.Error(), "moved") {
		t.Fatalf("the old place still takes a magpie: %v", err)
	}
	if tx, _ := Status(e); tx == nil || tx.State != StateComplete {
		t.Fatalf("record: %+v", tx)
	}
	appdir.UseExecutable(e)
	defer appdir.UseExecutable("")
	lease, err := Start(e)
	if err != nil {
		t.Fatalf("a start after the move: %v", err)
	}
	lease()
}

// A target that has files is moved aside to a dated backup, never merged
// into or removed; moving back the other way works the same.
func TestMoveBacksUpTarget(t *testing.T) {
	e := exe(t)
	installedData(t, e)
	data := filepath.Join(filepath.Dir(e), "data")
	write(t, filepath.Join(data, "old.txt"), "old")
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(data, "old.txt")) {
		t.Fatal("the target was merged into")
	}
	tx, _ := Status(e)
	b := tx.Backups[data]
	if !strings.HasPrefix(filepath.Base(b), "data.backup-") || read(t, filepath.Join(b, "old.txt")) != "old" {
		t.Fatalf("backup %q", b)
	}
	write(t, filepath.Join(data, "settings.json"), `{"a":2}`)
	if err := runMove(t, e, appdir.ModePortable, appdir.ModeInstalled); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(appdir.Installed(), "settings.json")) != `{"a":2}` {
		t.Fatal("moving back lost the portable change")
	}
	if exists(filepath.Join(appdir.Installed(), "cache")) {
		t.Fatal("the portable cache folder went into the config folder")
	}
	if appdir.Resolve(e) != "" {
		t.Fatal("the data folder left beside magpie is taken for its data again")
	}
}

// A move that fails after its publish puts both places back: the copy is
// removed, the target's own files return, the mode file isn't written.
func TestMoveFailureRestores(t *testing.T) {
	e := exe(t)
	installedData(t, e)
	data := filepath.Join(filepath.Dir(e), "data")
	write(t, filepath.Join(data, "old.txt"), "old")
	afterPublish = func() error { return errors.New("disk full") }
	defer func() { afterPublish = func() error { return nil } }()
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err == nil {
		t.Fatal("the move succeeded")
	}
	if read(t, filepath.Join(data, "old.txt")) != "old" || exists(filepath.Join(data, "settings.json")) {
		t.Fatal("the target wasn't put back")
	}
	if m, _ := appdir.ReadMode(e); m != "" {
		t.Fatalf("mode file written: %q", m)
	}
	tx, _ := Status(e)
	if tx.State != StateFailed || !strings.Contains(tx.Error, "disk full") {
		t.Fatalf("record: %+v", tx)
	}
	lease, err := Enter(context.Background(), []string{appdir.Installed(), data})
	if err != nil {
		t.Fatalf("a failed move left a place closed: %v", err)
	}
	lease()
	matches, _ := filepath.Glob(data + ".*")
	if len(matches) != 0 {
		t.Fatalf("left behind: %v", matches)
	}
}

// The helper waits for every magpie on either place to exit, and gives up
// when one doesn't, the source kept.
func TestRunWaitsForEveryMagpie(t *testing.T) {
	e := exe(t)
	src := installedData(t, e)
	lease, err := Enter(context.Background(), []string{src.Config})
	if err != nil {
		t.Fatal(err)
	}
	old := ExitWait
	ExitWait = 300 * time.Millisecond
	defer func() { ExitWait = old }()
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err == nil {
		t.Fatal("the move ran while a magpie held its lease")
	}
	lease()
	if exists(filepath.Join(filepath.Dir(e), "data", "settings.json")) {
		t.Fatal("copied while a magpie ran")
	}
	if tx, _ := Status(e); tx.State != StateFailed {
		t.Fatalf("state %s", tx.State)
	}
	// a lease ended in time is waited for
	lease, _ = Enter(context.Background(), []string{src.Config})
	go func() { time.Sleep(100 * time.Millisecond); lease() }()
	ExitWait = 10 * time.Second
	if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
}

// A start settles a move left behind: one just authorized is waited for,
// an old one is undone, a published one with its mode file finished.
func TestSettle(t *testing.T) {
	e := exe(t)
	installedData(t, e)
	tx, err := Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := Authorize(context.Background(), e, tx.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := Start(e); !errors.Is(err, ErrMoving) {
		t.Fatalf("a start during the move: %v", err)
	}
	old := settleGrace
	settleGrace = 0
	defer func() { settleGrace = old }()
	lease, err := Start(e)
	if err != nil {
		t.Fatalf("an abandoned move kept magpie from starting: %v", err)
	}
	lease()
	if tx, _ := Status(e); tx.State != StateFailed || !strings.Contains(tx.Error, "interrupted") {
		t.Fatalf("record: %+v", tx)
	}
	if err := Run(context.Background(), e); err == nil {
		t.Fatal("a helper ran a move that was given up")
	}

	// published, mode file written, record not: finished
	tx, _ = Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil)
	Authorize(context.Background(), e, tx.ID)
	// the helper dies once the mode file is written
	afterPublish = func() error { appdir.WriteMode(e, appdir.ModePortable); panic("crash") }
	func() {
		defer func() { recover() }()
		Run(context.Background(), e)
	}()
	afterPublish = func() error { return nil }
	if err := Settle(e); err != nil {
		t.Fatal(err)
	}
	if tx, _ := Status(e); tx.State != StateComplete {
		t.Fatalf("a published move wasn't finished: %+v", tx)
	}
	if !exists(filepath.Join(filepath.Dir(e), "data", "settings.json")) {
		t.Fatal("the published copy is gone")
	}
}

// Cancel gives a move up whatever its age; Dismiss forgets one that's over.
func TestCancelAndDismiss(t *testing.T) {
	e := exe(t)
	installedData(t, e)
	tx, _ := Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil)
	if err := Dismiss(e); !errors.Is(err, ErrMoving) {
		t.Fatalf("dismissed a running move: %v", err)
	}
	Authorize(context.Background(), e, tx.ID)
	if err := Cancel(e); err != nil {
		t.Fatal(err)
	}
	if tx, _ := Status(e); tx.State != StateFailed || !strings.Contains(tx.Error, "cancelled") {
		t.Fatalf("record: %+v", tx)
	}
	if err := Dismiss(e); err != nil {
		t.Fatal(err)
	}
	if tx, _ := Status(e); tx != nil {
		t.Fatal("not forgotten")
	}
}

// Preflight refuses a place magpie can't write.
func TestPreflightNeedsAWritableFolder(t *testing.T) {
	e := exe(t)
	old := Writable
	defer func() { Writable = old }()
	Writable = func(dir string) error {
		if dir == filepath.Dir(e) {
			return errors.New("read-only")
		}
		return nil
	}
	if Preflight(e, appdir.ModePortable) == nil {
		t.Fatal("a read-only program folder passed")
	}
	if _, err := Prepare(e, appdir.ModeInstalled, appdir.ModePortable, nil); err == nil {
		t.Fatal("prepared a move to a read-only folder")
	}
}
