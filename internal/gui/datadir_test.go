package gui

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/datamove"
)

// moveHere is a magpie in a folder of its own, its data installed, and a
// move here whose steps stand in for the window's: idle at once, nothing
// to stop.
func moveHere(t *testing.T) (exe string, thawed *int) {
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
	exe = filepath.Join(dir, "app", "moepie.exe")
	for path, body := range map[string]string{exe: "binary", filepath.Join(appdir.Installed(), "settings.json"): "{}"} {
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	appdir.UseExecutable(exe)
	thawed = new(int)
	oldExe, oldIdle, oldFreeze, oldThaw, oldStop, oldHelper, oldWait := moveExe, moveIdle, freezePlugins, thawPlugins, stopMCP, startHelper, helperWait
	oldArgs, oldBind := moveArgs, bindBrowserWriters
	moveArgs = func() []string { return nil } // this fixture creates no native window
	bindBrowserWriters = func(string, string) error { return nil }
	moveExe = func() (string, error) { return exe, nil }
	moveIdle = func() bool { return true }
	freezePlugins = func(time.Duration) error { return nil }
	thawPlugins = func() { *thawed++ }
	stopMCP = func(time.Duration) error { return nil }
	t.Cleanup(func() {
		dataMoves.mu.Lock()
		done := dataMoves.done
		dataMoves.mu.Unlock()
		if done != nil {
			<-done
		}
		moveExe, moveIdle, freezePlugins, thawPlugins, stopMCP, startHelper, helperWait = oldExe, oldIdle, oldFreeze, oldThaw, oldStop, oldHelper, oldWait
		moveArgs, bindBrowserWriters = oldArgs, oldBind
		appdir.UseExecutable("")
		moving.Store(false)
		datamove.Business.Open()
		dataMoves = dataMover{}
	})
	return exe, thawed
}

// The window stops its work, has the helper take the move and quits; the
// helper copies once it is gone and writes the mode file.
func TestDataMoveQuitsForTheHelper(t *testing.T) {
	exe, _ := moveHere(t)
	startHelper = func(exe string) error {
		go datamove.Run(context.Background(), exe)
		return nil
	}
	w := &quitCount{}
	if err := dataMoves.start(w, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	if err := dataMoves.start(w, appdir.ModePortable); err == nil {
		t.Fatal("a second move started while one runs")
	}
	eventually(t, "the window didn't quit", func() bool { return w.quits.Load() == 1 })
	if !moving.Load() || !datamove.Business.Closed() {
		t.Fatal("the window took work again on its way out")
	}
	eventually(t, "the move didn't finish", func() bool {
		tx, _ := datamove.Status(exe)
		return tx != nil && tx.State == datamove.StateComplete
	})
	if mode, _ := appdir.ReadMode(exe); mode != appdir.ModePortable {
		t.Fatalf("mode %q", mode)
	}
	if _, err := os.Stat(filepath.Join(appdir.PortableData(exe), "settings.json")); err != nil {
		t.Fatal(err)
	}
}

// A helper that never takes the move: the window gives it up, says why
// and goes on as it was.
func TestDataMoveWithoutHelperGoesOn(t *testing.T) {
	exe, thawed := moveHere(t)
	startHelper = func(string) error { return nil }
	helperWait = 100 * time.Millisecond
	w := &quitCount{}
	if err := dataMoves.start(w, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the move wasn't given up", func() bool {
		tx, _ := datamove.Status(exe)
		return tx != nil && tx.State == datamove.StateFailed
	})
	eventually(t, "the window didn't take work again", func() bool {
		return !moving.Load() && !datamove.Business.Closed() && *thawed == 1
	})
	if w.quits.Load() != 0 {
		t.Fatal("the window quit with no helper to open it again")
	}
	if mode, _ := appdir.ReadMode(exe); mode != "" {
		t.Fatalf("mode %q written", mode)
	}
	if got := appdir.Resolve(exe); got != "" {
		t.Fatalf("a helper that never started selected portable data: %q", got)
	}
	// a start is let in again: the closed markers went with the record
	if release, err := datamove.Start(exe); err != nil {
		t.Fatal(err)
	} else {
		release()
	}
}

// A missing/inaccessible native writer proof aborts before the helper starts.
func TestDataMoveRefusesUntrackedBrowserWriters(t *testing.T) {
	exe, _ := moveHere(t)
	bindBrowserWriters = func(string, string) error { return errors.New("browser job access denied") }
	startHelper = func(string) error { t.Error("helper started without writer proof"); return nil }
	w := &quitCount{}
	if err := dataMoves.start(w, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	eventually(t, "untracked move wasn't aborted", func() bool {
		tx, _ := datamove.Status(exe)
		return tx != nil && tx.State == datamove.StateFailed && tx.Error == "browser job access denied"
	})
	eventually(t, "window did not resume", func() bool { return !moving.Load() && !datamove.Business.Closed() })
	if w.quits.Load() != 0 {
		t.Fatal("window quit without writer proof")
	}
	if mode, _ := appdir.ReadMode(exe); mode != "" {
		t.Fatalf("mode changed: %q", mode)
	}
}

// A plugin host or MCP server that doesn't exit stops the move before
// anything is recorded or closed.
func TestDataMoveStopsWhenAChildStays(t *testing.T) {
	exe, thawed := moveHere(t)
	stopMCP = func(time.Duration) error { return errors.New("an MCP server did not exit in time") }
	startHelper = func(string) error { t.Error("helper started"); return nil }
	if err := dataMoves.start(&quitCount{}, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the move didn't stop", func() bool {
		dataMoves.mu.Lock()
		defer dataMoves.mu.Unlock()
		return dataMoves.phase == "" && dataMoves.err != ""
	})
	if tx, _ := datamove.Status(exe); tx != nil {
		t.Fatalf("recorded: %+v", tx)
	}
	if *thawed != 1 || moving.Load() || datamove.Business.Closed() {
		t.Fatal("the window didn't go on")
	}
}

// A move waiting for idle can be called off; the page's own requests go on
// meanwhile, its writes wait.
func TestDataMoveWaitsForIdle(t *testing.T) {
	moveHere(t)
	moveIdle = func() bool { return false }
	if err := dataMoves.start(&quitCount{}, appdir.ModePortable); err != nil {
		t.Fatal(err)
	}
	eventually(t, "closed", datamove.Business.Closed)
	h := datamove.Business.Guard(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {}), dataControl)
	for _, c := range []struct {
		method, path string
		code         int
	}{
		{"GET", "/api/state", 200},
		{"POST", "/api/data-directory/cancel", 200},
		{"POST", "/api/window/main", 200},
		{"POST", "/api/settings", http.StatusServiceUnavailable},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
		if rec.Code != c.code {
			t.Errorf("%s %s: %d", c.method, c.path, rec.Code)
		}
	}
	if !dataMoves.stop() {
		t.Fatal("a waiting move wasn't called off")
	}
	eventually(t, "the window didn't go on", func() bool { return !moving.Load() && !datamove.Business.Closed() })
}

func TestDataDirectoryStatusKeepsInstalledSelection(t *testing.T) {
	exe, _ := moveHere(t)
	mux := http.NewServeMux()
	dataDirRoutes(mux, &quitCount{})
	for range 2 {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/data-directory", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status: %d %s", rec.Code, rec.Body.String())
		}
	}
	if got := appdir.Resolve(exe); got != "" {
		t.Fatalf("reading Settings changed the next startup directory: %q", got)
	}
	if _, err := os.Stat(appdir.PortableData(exe)); !os.IsNotExist(err) {
		t.Fatalf("reading Settings created portable data: %v", err)
	}
}

func TestDataMoveShowsResolvedCachePaths(t *testing.T) {
	exe, _ := moveHere(t)
	st := dataDirStatus(&quitCount{})
	if len(st.Places) != 2 {
		t.Fatalf("places: %+v", st)
	}
	for _, p := range st.Places {
		want, err := datamove.PlacesOf(exe, p.Mode)
		if err != nil {
			t.Fatal(err)
		}
		cache := want.SystemCache
		if appdir.SameCachePath(want.Cache, cache) {
			cache = ""
		}
		if p.Config != want.Config || p.Cache != want.Cache || p.SystemCache != cache || p.Web != want.Web {
			t.Fatalf("displayed paths: %+v; resolved paths: %+v", p, want)
		}
	}
}

// magpie web's page and a browser on the app's can't move the data: the
// app quits for it.
func TestDataMoveFromTheWindowOnly(t *testing.T) {
	moveHere(t)
	if err := dataMoves.start(webHost{}, appdir.ModePortable); err == nil {
		t.Fatal("a browser's page started a move")
	}
	if st := dataDirStatus(webHost{}); st.Unavailable == "" || st.Mode != appdir.ModeInstalled || len(st.Places) != 2 {
		t.Fatalf("%+v", st)
	}
}
