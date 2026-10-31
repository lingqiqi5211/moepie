package gui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/datamove"
	"github.com/yetone/magpie/internal/library"
	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/update"
)

// Settings › General moves magpie's data between its two places: the
// installed one (~/.config/magpie, ~/.cache/magpie and, on Windows,
// WebView2's own default profile) and the one beside the app (data/). The
// window can't copy what it is using, so it stops its work and quits, and
// a helper of the same program copies once it has exited, then opens the
// window again (internal/datamove, magpie data-directory migrate).

// moving is set while a move takes this window down: an update is neither
// put in nor handed over on the way out, nor restarted into meanwhile.
var moving atomic.Bool

// The waits of a move here: for the agents' work to be idle, for plugins
// and MCP servers to exit, and for the helper to take the move.
var (
	moveIdleMost = 15 * time.Minute
	moveStopWait = 30 * time.Second
	helperWait   = 15 * time.Second
)

// What a move here does, vars for the tests.
var (
	moveExe            = os.Executable
	moveArgs           = func() []string { return os.Args[1:] }
	bindBrowserWriters = datamove.BindBrowserWriters
	moveIdle           = func() bool { return idleAt(restartBusy(), time.Now()) }
	freezePlugins      = plugin.Freeze
	thawPlugins        = plugin.Thaw
	stopMCP            = library.StopMCP
	startHelper        = func(exe string) error { return update.StartDetached(exe, "data-directory", "migrate") }
)

// dataMover is the move this window runs, until it quits or gives up.
type dataMover struct {
	mu     sync.Mutex
	phase  string // "", "waiting" (for idle), "stopping", "quitting"
	to     string
	err    string // why the last try here stopped before a move was recorded
	cancel context.CancelFunc
	done   chan struct{} // closed once run returns
}

var dataMoves dataMover

// dataPlace is one of the two places, as Settings shows it.
type dataPlace struct {
	Mode        string `json:"mode"`
	Config      string `json:"config"`
	Cache       string `json:"cache"`
	SystemCache string `json:"systemCache,omitempty"`
	Web         string `json:"web,omitempty"`
	// why magpie can't move its data there now, "" when it can
	Blocked string `json:"blocked,omitempty"`
}

type dataStatus struct {
	Mode   string      `json:"mode"`
	Places []dataPlace `json:"places"`
	// off Windows the system webview keeps its storage where it is
	WebStays bool `json:"webStays"`
	// why this page can't move the data: a browser's, not the app's
	Unavailable string                `json:"unavailable,omitempty"`
	Phase       string                `json:"phase,omitempty"`
	To          string                `json:"to,omitempty"`
	Error       string                `json:"error,omitempty"`
	Move        *datamove.Transaction `json:"move,omitempty"`
}

func dataDirStatus(w Windows) dataStatus {
	st := dataStatus{Mode: datamove.Mode(), WebStays: runtime.GOOS != "windows"}
	if isWeb(w) {
		st.Unavailable = "web"
	}
	exe, err := moveExe()
	if err != nil {
		st.Error = err.Error()
		return st
	}
	for _, mode := range []string{appdir.ModeInstalled, appdir.ModePortable} {
		pl, err := datamove.PlacesOf(exe, mode)
		p := dataPlace{Mode: mode, Config: pl.Config, Cache: pl.Cache, Web: pl.Web}
		if !appdir.SameCachePath(pl.Cache, pl.SystemCache) {
			p.SystemCache = pl.SystemCache
		}
		if err == nil && mode != st.Mode {
			err = datamove.Preflight(exe, mode)
		}
		if err != nil {
			p.Blocked = err.Error()
		}
		st.Places = append(st.Places, p)
	}
	dataMoves.mu.Lock()
	st.Phase, st.To, st.Error = dataMoves.phase, dataMoves.to, dataMoves.err
	dataMoves.mu.Unlock()
	if tx, err := datamove.Status(exe); err != nil {
		st.Error = err.Error()
	} else {
		st.Move = tx
	}
	return st
}

// start moves the data to mode's place: in the background, the page
// following it in the status.
func (d *dataMover) start(w Windows, to string) error {
	if isWeb(w) {
		return errors.New("the data directory is moved from the app's own window")
	}
	if to != appdir.ModeInstalled && to != appdir.ModePortable {
		return errors.New("unknown data directory")
	}
	exe, err := moveExe()
	if err != nil {
		return err
	}
	if err := datamove.Preflight(exe, to); err != nil {
		return err
	}
	tx, statusErr := datamove.Status(exe)
	if statusErr != nil {
		return statusErr
	}
	cleanup := tx != nil && tx.State == datamove.StateCleanup
	if cleanup && to != tx.To {
		return errors.New("finish old data cleanup before starting another move")
	}
	if to == datamove.Mode() && !cleanup {
		return errors.New("the data is in that place already")
	}
	if tx != nil && !tx.Terminal() && !cleanup {
		return datamove.ErrMoving
	}
	d.mu.Lock()
	if d.phase != "" {
		d.mu.Unlock()
		return datamove.ErrMoving
	}
	ctx, cancel := context.WithCancel(context.Background())
	d.phase, d.to, d.err, d.cancel = "waiting", to, "", cancel
	d.done = make(chan struct{})
	done := d.done
	d.mu.Unlock()
	go func() {
		defer close(done)
		d.run(ctx, w, exe, to)
	}()
	return nil
}

func (d *dataMover) set(phase string) {
	d.mu.Lock()
	d.phase = phase
	d.mu.Unlock()
}

// stop calls off a move still waiting here; once the helper has it, the
// move runs.
func (d *dataMover) stop() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cancel == nil || d.phase == "quitting" {
		return false
	}
	d.cancel()
	return true
}

func (d *dataMover) run(ctx context.Context, w Windows, exe, to string) {
	moving.Store(true)
	updates.cancelWait()
	datamove.Business.Close()
	frozen := false
	giveUp := func(err error) {
		if frozen {
			thawPlugins()
		}
		datamove.Business.Open()
		moving.Store(false)
		d.mu.Lock()
		d.phase, d.cancel = "", nil
		if err != nil {
			d.err = err.Error()
		}
		d.mu.Unlock()
	}
	if err := waitIdle(ctx); err != nil {
		giveUp(err)
		return
	}
	d.set("stopping")
	frozen = true
	if err := freezePlugins(moveStopWait); err != nil {
		giveUp(err)
		return
	}
	if err := stopMCP(moveStopWait); err != nil {
		giveUp(err)
		return
	}
	if ctx.Err() != nil {
		giveUp(errors.New("the data move was cancelled"))
		return
	}
	existing, err := datamove.Status(exe)
	var tx *datamove.Transaction
	if err == nil && existing != nil && existing.State == datamove.StateCleanup {
		tx, err = datamove.RetryCleanup(ctx, exe)
	} else if err == nil {
		tx, err = datamove.Prepare(exe, datamove.Mode(), to, moveArgs())
	}
	if err != nil {
		giveUp(err)
		return
	}
	// from here a failure is the record's to say (Abort)
	abort := func(why string) {
		datamove.Abort(exe, tx.ID, why)
		if taken(exe, tx.ID) {
			d.quit(w)
			return
		}
		giveUp(nil)
	}
	if err := bindBrowserWriters(exe, tx.ID); err != nil {
		abort(err.Error())
		return
	}
	if tx.State == datamove.StatePrepared {
		if err := datamove.Authorize(ctx, exe, tx.ID); err != nil {
			abort(err.Error())
			return
		}
	}
	d.set("quitting")
	if err := startHelper(exe); err != nil {
		abort("the data move's helper didn't start: " + err.Error())
		return
	}
	for end := time.Now().Add(helperWait); time.Now().Before(end); time.Sleep(100 * time.Millisecond) {
		if taken(exe, tx.ID) {
			d.quit(w)
			return
		}
	}
	abort("the data move's helper didn't start in time")
}

// taken is whether the helper has the move id, done or not.
func taken(exe, id string) bool {
	tx, err := datamove.Status(exe)
	return err == nil && tx != nil && tx.ID == id && tx.Helper != 0
}

// quit ends this window for the helper, which opens it again.
func (d *dataMover) quit(w Windows) {
	d.set("quitting")
	w.Quit()
}

// waitIdle waits for nothing to be in flight here: the page's and agents'
// requests let in before the move closed them, and the agents' turns.
func waitIdle(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, moveIdleMost)
	defer cancel()
	for {
		if datamove.Business.Wait(ctx) == nil && moveIdle() {
			return nil
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return errors.New("magpie's agents didn't stop working in time; the data stayed where it was")
			}
			return errors.New("the data move was cancelled")
		case <-time.After(waitTick):
		}
	}
}

// dataControl are the requests a move waiting for idle doesn't hold up:
// reads, and the page's own following of the move and its window.
func dataControl(r *http.Request) bool {
	p := r.URL.Path
	return !strings.HasPrefix(p, "/api/") || r.Method == http.MethodGet || r.Method == http.MethodHead ||
		strings.HasPrefix(p, "/api/data-directory") || strings.HasPrefix(p, "/api/window/")
}

func dataDirRoutes(mux *http.ServeMux, w Windows) {
	mux.HandleFunc("GET /api/data-directory", func(rw http.ResponseWriter, r *http.Request) {
		writeJSON(rw, dataDirStatus(w))
	})
	mux.HandleFunc("POST /api/data-directory/start", func(rw http.ResponseWriter, r *http.Request) {
		var in struct {
			Mode string `json:"mode"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			fail(rw, err)
			return
		}
		if err := dataMoves.start(w, in.Mode); err != nil {
			fail(rw, err)
			return
		}
		writeJSON(rw, dataDirStatus(w))
	})
	// retry is the failed move again, the same way
	mux.HandleFunc("POST /api/data-directory/retry", func(rw http.ResponseWriter, r *http.Request) {
		exe, err := moveExe()
		if err != nil {
			fail(rw, err)
			return
		}
		tx, err := datamove.Status(exe)
		if err == nil && (tx == nil || tx.State != datamove.StateFailed && tx.State != datamove.StateCleanup) {
			err = errors.New("no failed data move to try again")
		}
		if err == nil {
			err = dataMoves.start(w, tx.To)
		}
		if err != nil {
			fail(rw, err)
			return
		}
		writeJSON(rw, dataDirStatus(w))
	})
	// cancel calls off a move still waiting in this window; one left
	// unfinished by another is settled as interrupted
	mux.HandleFunc("POST /api/data-directory/cancel", func(rw http.ResponseWriter, r *http.Request) {
		if !dataMoves.stop() {
			exe, err := moveExe()
			if err == nil {
				err = datamove.Cancel(exe)
			}
			if err != nil {
				fail(rw, err)
				return
			}
		}
		writeJSON(rw, dataDirStatus(w))
	})
	// dismiss forgets a move that is over, and the reason a try here stopped
	mux.HandleFunc("POST /api/data-directory/dismiss", func(rw http.ResponseWriter, r *http.Request) {
		exe, err := moveExe()
		if err == nil {
			err = datamove.Dismiss(exe)
		}
		if err != nil {
			fail(rw, err)
			return
		}
		dataMoves.mu.Lock()
		dataMoves.err = ""
		dataMoves.mu.Unlock()
		writeJSON(rw, dataDirStatus(w))
	})
}
