// Package datamove moves magpie's data between its two places, the
// installed one (the user's config and cache folders, and on Windows the
// WebView2 profile in %AppData%) and the portable one (the data folder
// beside magpie), with no magpie running on it meanwhile. See
// docs/data-directory.md.
package datamove

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/edit"
)

// TransactionName is the move's record, beside the mode file: outside
// both places, so neither move nor backup takes it along.
const TransactionName = "moepie-data-migration.json"

// A move's states. Prepared is the window stopping work; copying is the
// helper copying into staging folders; published has the copies in place
// and the mode file next.
const (
	StatePrepared  = "prepared"
	StateCopying   = "copying"
	StatePublished = "published"
	StateCleanup   = "cleanup"
	StateComplete  = "complete"
	StateFailed    = "failed"
)

// WebSkip are what a WebView2 profile holds that Chromium makes again: its
// caches, crash reports and metrics, and the lock of a running browser.
// They are left out wherever they are in the profile; the pages' storage
// (Local Storage, IndexedDB, Cookies, Local State, Preferences) moves.
var WebSkip = []string{
	"Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache",
	"GraphiteDawnCache", "GPUPersistentCache", "DawnCache", "DawnGraphiteCache",
	"DawnWebGPUCache", "Crashpad", "BrowserMetrics", "BrowserMetrics-spare.pma",
	"CrashpadMetrics-active.pma", "component_crx_cache", "extensions_crx_cache",
	"lockfile",
}

// stageOwner, in a staging folder's runtime folder, names the move that
// made it: only that move's cleanup removes it, published or not.
const stageOwner = "stage-owner"

// Places are one mode's folders: Web is the WebView2 profile, "" off
// Windows, where the system webview keeps its storage where it is.
type Places struct{ Config, Cache, SystemCache, Web string }

// PlacesOf are the folders of mode for a magpie run from exe.
func PlacesOf(exe, mode string) (Places, error) {
	win := runtime.GOOS == "windows"
	systemCache, err := appdir.InstalledSystemCache()
	if err != nil {
		return Places{}, err
	}
	sharedCache := appdir.SameCachePath(systemCache, appdir.InstalledCache())
	if mode == appdir.ModePortable {
		data := appdir.PortableData(exe)
		p := Places{Config: data, Cache: filepath.Join(data, "cache"), SystemCache: filepath.Join(data, "cache")}
		if !sharedCache {
			p.SystemCache = filepath.Join(data, "system-cache")
		}
		if win {
			p.Web = filepath.Join(data, "webview2")
		}
		return p, nil
	}
	if mode != appdir.ModeInstalled {
		return Places{}, fmt.Errorf("unknown data directory mode %q", mode)
	}
	if _, err := appdir.Home(); err != nil {
		return Places{}, err
	}
	p := Places{Config: appdir.Installed(), Cache: appdir.InstalledCache(), SystemCache: systemCache}
	if win {
		// WebView2's default with no folder given: %AppData%\<exe name>
		ad := os.Getenv("AppData")
		if !filepath.IsAbs(ad) {
			return Places{}, errors.New("AppData is not set")
		}
		p.Web = filepath.Join(ad, filepath.Base(exe))
	}
	return p, nil
}

// Pair is a folder copied to another; Web has WebSkip left out.
type Pair struct {
	From string `json:"from"`
	To   string `json:"to"`
	Web  bool   `json:"web,omitempty"`
}

// Pairs map from's folders onto to's: config to config, cache to cache,
// profile to profile. Portable's cache and profile are inside its data
// folder, so they are left out of the config copy and copied on their own.
func Pairs(exe, from, to string) ([]Pair, error) {
	a, err := PlacesOf(exe, from)
	if err != nil {
		return nil, err
	}
	b, err := PlacesOf(exe, to)
	if err != nil {
		return nil, err
	}
	ps := []Pair{{From: a.Config, To: b.Config}, {From: a.Cache, To: b.Cache}}
	if !appdir.SameCachePath(a.Cache, a.SystemCache) {
		ps = append(ps, Pair{From: a.SystemCache, To: b.SystemCache})
	}
	if a.Web != "" {
		ps = append(ps, Pair{From: a.Web, To: b.Web, Web: true})
	}
	return ps, nil
}

// BrowserProof identifies the native desktop's pre-existing writer job.
// Handles are opened before the helper acknowledges the handoff.
type BrowserProof struct {
	Job     string `json:"job"`
	PID     uint32 `json:"pid"`
	Created uint64 `json:"created"`
}

// Transaction is a move, recorded beside magpie.
type Transaction struct {
	Browser        *BrowserProof     `json:"browser,omitempty"`
	CleanupStarted bool              `json:"cleanupStarted,omitempty"`
	Cleanup        []CleanupPlan     `json:"cleanup,omitempty"`
	Version        int               `json:"version"`
	ID             string            `json:"id"`
	Exe            string            `json:"exe"`
	Args           []string          `json:"args,omitempty"` // the window's, to start it again
	From           string            `json:"from"`
	To             string            `json:"to"`
	Pairs          []Pair            `json:"pairs"`
	Backups        map[string]string `json:"backups,omitempty"` // a target that had files: where they went
	State          string            `json:"state"`
	Quiesced       bool              `json:"quiesced"` // the window stopped its work and children
	Helper         int               `json:"helper,omitempty"`
	Error          string            `json:"error,omitempty"`
	Updated        time.Time         `json:"updated"`
}

// Terminal is whether the move is over, done or not.
func (tx *Transaction) Terminal() bool {
	return tx.State == StateComplete || tx.State == StateFailed
}

func transactionPath(exe string) string {
	return filepath.Join(filepath.Dir(appdir.ModePath(exe)), TransactionName)
}

func txLock(exe string) string { return transactionPath(exe) + ".lock" }

// Status is the last move, or nil with none.
func Status(exe string) (*Transaction, error) {
	b, err := os.ReadFile(transactionPath(exe))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var tx Transaction
	if err := json.Unmarshal(b, &tx); err != nil || tx.Version != 1 || len(tx.ID) != 32 || len(tx.Pairs) == 0 {
		return nil, fmt.Errorf("data move record %s is not readable", transactionPath(exe))
	}
	for _, p := range tx.Pairs {
		if !filepath.IsAbs(p.From) || !filepath.IsAbs(p.To) {
			return nil, fmt.Errorf("data move record %s is not readable", transactionPath(exe))
		}
	}
	if err := validatePaths(exe, &tx); err != nil {
		return nil, err
	}
	return &tx, nil
}

func save(exe string, tx *Transaction) error {
	tx.Updated = time.Now().UTC()
	b, err := json.MarshalIndent(tx, "", "  ")
	if err != nil {
		return err
	}
	return edit.WriteAtomic(transactionPath(exe), append(b, '\n'))
}

// Dismiss forgets a move that is over, once its result is shown.
func Dismiss(exe string) error {
	unlock, err := lockFor(exe, time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	tx, err := Status(exe)
	if err != nil || tx == nil {
		return err
	}
	if !tx.Terminal() {
		return ErrMoving
	}
	return os.Remove(transactionPath(exe))
}

// ErrNoMove is a helper with no authorized move to run.
var ErrNoMove = errors.New("no data move is waiting")

// ErrMoving is a start while a move runs.
var ErrMoving = errors.New("magpie is moving its data directory; it opens again once the move is done")

func lockFor(exe string, d time.Duration) (func(), error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	unlock, err := strictLock(ctx, txLock(exe))
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, ErrMoving
	}
	return unlock, err
}

// Preflight says why magpie run from exe can't move its data to mode's
// place: the folders it would write in can't be written.
func Preflight(exe, mode string) error {
	if mode != appdir.ModeInstalled && mode != appdir.ModePortable {
		return fmt.Errorf("unknown data directory mode %q", mode)
	}
	other := appdir.ModeInstalled
	if mode == other {
		other = appdir.ModePortable
	}
	pairs, err := Pairs(exe, other, mode)
	if err != nil {
		return err
	}
	if err := validatePaths(exe, &Transaction{Exe: exe, From: other, To: mode, Pairs: pairs}); err != nil {
		return err
	}
	// the mode file and the move's record go beside magpie either way
	if err := Writable(filepath.Dir(appdir.ModePath(exe))); err != nil {
		return err
	}
	p, err := PlacesOf(exe, mode)
	if err != nil {
		return err
	}
	for _, d := range []string{p.Config, p.Cache, p.SystemCache, p.Web} {
		if d == "" {
			continue
		}
		if err := Writable(filepath.Dir(d)); err != nil {
			return err
		}
	}
	return nil
}

// Writable probes the nearest existing parent of dir without creating a
// missing destination. Creating data/ during a Settings read would select
// portable mode on the next start before any migration was confirmed.
var Writable = func(dir string) error {
	for {
		_, err := os.Stat(dir)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s can't be written: %w", dir, err)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return fmt.Errorf("%s can't be written: %w", dir, err)
		}
		dir = parent
	}
	f, err := os.CreateTemp(dir, ".moepie-probe-*")
	if err != nil {
		return fmt.Errorf("%s can't be written: %w", dir, err)
	}
	f.Close()
	os.Remove(f.Name())
	return nil
}

func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Prepare records a move of exe's data from one mode's place to the
// other's. Nothing is blocked yet: the window stops its work, then
// Authorize.
func Prepare(exe, from, to string, args []string) (*Transaction, error) {
	if !validMode(from) || !validMode(to) || from == to {
		return nil, errors.New("the data is in that place already")
	}
	if err := Preflight(exe, to); err != nil {
		return nil, err
	}
	pairs, err := Pairs(exe, from, to)
	if err == nil {
		err = validatePaths(exe, &Transaction{Exe: exe, From: from, To: to, Pairs: pairs})
	}
	if err != nil {
		return nil, err
	}
	unlock, err := lockFor(exe, 5*time.Second)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if tx, err := Status(exe); err != nil {
		return nil, err
	} else if tx != nil && !tx.Terminal() {
		return nil, ErrMoving
	}
	id, err := newID()
	if err != nil {
		return nil, err
	}
	tx := &Transaction{Version: 1, ID: id, Exe: exe, Args: args, From: from, To: to, Pairs: pairs, State: StatePrepared}
	return tx, save(exe, tx)
}

// sources are the folders the move copies from; targets those it writes.
func sources(tx *Transaction) []string {
	var d []string
	for _, p := range tx.Pairs {
		d = append(d, p.From)
	}
	return d
}

func targets(tx *Transaction) []string {
	var d []string
	for _, p := range tx.Pairs {
		d = append(d, p.To)
	}
	return d
}

const closedNote = "magpie is moving its data directory; wait for it to finish"

// Authorize closes both places to every other magpie and lets the helper
// run the move: the window has stopped its work and its children.
func Authorize(ctx context.Context, exe, id string) error {
	unlock, err := lockFor(exe, 5*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	tx, err := Status(exe)
	if err != nil {
		return err
	}
	if tx == nil || tx.ID != id || tx.State != StatePrepared {
		return errors.New("the data move was cancelled")
	}
	if err := block(ctx, append(sources(tx), targets(tx)...), closedNote); err != nil {
		unblock(append(sources(tx), targets(tx)...))
		return err
	}
	tx.Quiesced = true
	return save(exe, tx)
}

// Abort gives up a move the helper hasn't taken: the window couldn't stop
// its work, or the helper didn't start.
func Abort(exe, id, why string) error {
	unlock, err := lockFor(exe, 5*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	tx, err := Status(exe)
	if err != nil || tx == nil || tx.ID != id || tx.Terminal() || tx.Helper != 0 {
		return err
	}
	if tx.State == StateCleanup {
		tx.Error = why
		unblock(targets(tx))
		return save(exe, tx)
	}
	fail(exe, tx, errors.New(why))
	return nil
}

// Waits a helper gives others to stop: the window's body to exit, and its
// WebView2 browser.
var (
	ExitWait = 3 * time.Minute
	WebWait  = time.Minute
)

// Run is the helper's move: once the window that authorized it has exited,
// it copies, checks and publishes, then writes the mode file. On failure
// both places are as they were and the record says why.
func Run(ctx context.Context, exe string) error {
	unlock, err := lockFor(exe, 30*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	tx, err := Status(exe)
	if err != nil {
		return err
	}
	if tx == nil || (tx.State != StatePrepared && tx.State != StateCleanup) || !tx.Quiesced || tx.Helper != 0 {
		return ErrNoMove
	}
	waitBrowser, closeBrowser, err := browserBarrier(tx)
	if err != nil {
		return err
	}
	defer closeBrowser()
	tx.Helper = os.Getpid()
	if err := save(exe, tx); err != nil {
		return err
	}
	if err := func() error {
		if err := waitBrowser(ctx); err != nil {
			return err
		}
		return move(ctx, exe, tx)
	}(); err != nil {
		mode, modeErr := appdir.ReadMode(exe)
		if tx.State == StateCleanup || modeErr != nil || mode == tx.To {
			tx.State, tx.Error = StateCleanup, err.Error()
			_ = save(exe, tx)
			unblock(targets(tx))
		} else {
			fail(exe, tx, err)
		}
		return err
	}
	return nil
}

func move(ctx context.Context, exe string, tx *Transaction) error {
	wait, cancel := context.WithTimeout(ctx, ExitWait)
	release, err := Exclusive(wait, append(sources(tx), targets(tx)...))
	cancel()
	if err != nil {
		return fmt.Errorf("magpie didn't exit in time: %w", err)
	}
	defer release()
	if err := validatePaths(exe, tx); err != nil {
		return err
	}
	if tx.State == StateCleanup {
		return cleanup(ctx, exe, tx)
	}
	// the gates are held while copying; a target's is let go before it is
	// moved aside, as Windows renames no folder with a file open in it
	for _, p := range tx.Pairs {
		if p.Web {
			for _, d := range []string{p.From, p.To} {
				if err := webViewGone(ctx, d, WebWait); err != nil {
					release()
					return err
				}
			}
		}
	}
	tx.State = StateCopying
	if err := save(exe, tx); err != nil {
		release()
		return err
	}
	if err := captureSources(exe, tx); err != nil {
		return err
	}
	err = stageAll(ctx, exe, tx)
	release()
	if err != nil {
		return err
	}
	// a target moved aside keeps no closed marker; the record's lock keeps
	// every start out meanwhile (Settle)
	unblock(targets(tx))
	if err := publish(exe, tx); err != nil {
		return err
	}
	if err := afterPublish(); err != nil {
		return err
	}
	if err := verifySources(tx); err != nil {
		return err
	}
	if err := verifyPublished(tx); err != nil {
		return err
	}
	if err := appdir.WriteMode(exe, tx.To); err != nil {
		return err
	}
	return finish(exe, tx)
}

// finish ends a published move whose mode file is written: the copies are
// the data now, and the old place says where it went.
func finish(exe string, tx *Transaction) error {
	if err := block(context.Background(), sources(tx), "magpie's data moved to "+targetsNote(tx)); err != nil {
		return err
	}
	return cleanup(context.Background(), exe, tx)
}

func targetsNote(tx *Transaction) string { return tx.Pairs[0].To }

// fail puts both places back as they were and records why.
func fail(exe string, tx *Transaction, why error) {
	rollback(tx)
	unblock(append(sources(tx), targets(tx)...))
	tx.State, tx.Error = StateFailed, why.Error()
	_ = save(exe, tx)
}

// tops are the pairs whose target isn't inside another's: each is staged
// beside its target and published in one rename.
func tops(ps []Pair) []Pair {
	var out []Pair
	for _, p := range ps {
		if inside(ps, p.To, func(q Pair) string { return q.To }) == "" {
			out = append(out, p)
		}
	}
	return out
}

// inside is the folder of another pair (by side) that holds dir, or "".
func inside(ps []Pair, dir string, side func(Pair) string) string {
	for _, q := range ps {
		if d := side(q); d != dir && contains(d, dir) {
			return d
		}
	}
	return ""
}

// inner are the top-level names of dir taken by other pairs' folders on
// that side: portable's cache and webview2 in its data folder.
func inner(ps []Pair, dir string, side func(Pair) string) []string {
	var names []string
	for _, q := range ps {
		d := side(q)
		if rel, err := filepath.Rel(dir, d); err == nil && d != dir && contains(dir, d) {
			names = append(names, strings.Split(rel, string(filepath.Separator))[0])
		}
	}
	return names
}

func from(p Pair) string { return p.From }
func to(p Pair) string   { return p.To }

// stage is where pair p is copied before it is published.
func stage(tx *Transaction, p Pair) string {
	if top := inside(tx.Pairs, p.To, to); top != "" {
		rel, _ := filepath.Rel(top, p.To)
		return filepath.Join(stage(tx, Pair{To: top}), rel)
	}
	return p.To + ".moving-" + tx.ID[:8]
}

func stageAll(ctx context.Context, exe string, tx *Transaction) error {
	for _, p := range tops(tx.Pairs) {
		if err := noLinks(stage(tx, p)); err != nil {
			return err
		}
		s := stage(tx, p)
		if err := os.MkdirAll(filepath.Join(s, runtimeName), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(s, runtimeName, stageOwner), []byte(tx.ID), 0o600); err != nil {
			return err
		}
	}
	for _, p := range tx.Pairs {
		if err := copyTree(ctx, p.From, stage(tx, p), skipper(tx, p, from)); err != nil {
			return err
		}
		_ = save(exe, tx)
	}
	if err := verifySources(tx); err != nil {
		return err
	}
	for _, p := range tx.Pairs {
		a, err := manifest(p.From, skipper(tx, p, from))
		if err != nil {
			return err
		}
		b, err := manifest(stage(tx, p), skipper(tx, p, to))
		if err != nil {
			return err
		}
		if !sameData(a, b) {
			return fmt.Errorf("the copy of %s differs from it", p.From)
		}
	}
	return nil
}

// skipper says what of pair p's folder on side isn't its to copy or
// compare: magpie's runtime folder, another pair's folder, and in a
// WebView2 profile what Chromium makes again.
func skipper(tx *Transaction, p Pair, side func(Pair) string) func(rel string) bool {
	top := inner(tx.Pairs, side(p), side)
	top = append(top, runtimeName)
	return func(rel string) bool {
		first := strings.Split(rel, string(filepath.Separator))[0]
		if rel == first && slices.Contains(top, first) {
			return true
		}
		return p.Web && slices.Contains(WebSkip, filepath.Base(rel))
	}
}

// backupName is where a target that has files goes before the copy takes
// its place: never merged into, never removed.
func backupName(dir string, now time.Time) string {
	b := dir + ".backup-" + now.Format("20060102-150405")
	for i := 2; ; i++ {
		if _, err := os.Lstat(b); errors.Is(err, os.ErrNotExist) {
			return b
		}
		b = fmt.Sprintf("%s.backup-%s-%d", dir, now.Format("20060102-150405"), i)
	}
}

func publish(exe string, tx *Transaction) error {
	if tx.Backups == nil {
		tx.Backups = map[string]string{}
	}
	for _, p := range tops(tx.Pairs) {
		if empty, err := isEmpty(p.To); err != nil {
			return err
		} else if empty {
			if err := os.RemoveAll(p.To); err != nil {
				return err
			}
		} else {
			b := backupName(p.To, time.Now())
			tx.Backups[p.To] = b
			if err := save(exe, tx); err != nil {
				return err
			}
			if err := os.Rename(p.To, b); err != nil {
				delete(tx.Backups, p.To)
				return fmt.Errorf("%s couldn't be moved aside: %w", p.To, err)
			}
		}
		if err := os.Rename(stage(tx, p), p.To); err != nil {
			return err
		}
	}
	tx.State = StatePublished
	return save(exe, tx)
}

// isEmpty is whether dir has nothing but magpie's runtime folder in it,
// or isn't there: the move's own lock and marker don't make it the user's.
func isEmpty(dir string) (bool, error) {
	names, err := readNames(dir)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return len(names) == 0 || len(names) == 1 && names[0] == runtimeName, nil
}

func readNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

func owned(dir, id string) bool {
	b, err := os.ReadFile(filepath.Join(dir, runtimeName, stageOwner))
	return err == nil && string(b) == id
}

// rollback removes what the move made, its staging folders and published
// copies, and puts every target it moved aside back.
func rollback(tx *Transaction) {
	ps := tops(tx.Pairs)
	for i := len(ps) - 1; i >= 0; i-- {
		p := ps[i]
		if owned(p.To, tx.ID) {
			os.RemoveAll(p.To)
		}
		if b, ok := tx.Backups[p.To]; ok {
			if _, err := os.Lstat(p.To); errors.Is(err, os.ErrNotExist) {
				if os.Rename(b, p.To) == nil {
					delete(tx.Backups, p.To)
				}
			}
		}
		if s := stage(tx, p); owned(s, tx.ID) {
			os.RemoveAll(s)
		}
	}
}

// Settle ends a move left unfinished, before any other start: one whose
// mode file was written is finished; any other is undone, both places put
// back. A move whose helper runs, or that was just authorized, is
// ErrMoving: the start waits for it. Settle never copies.
func Settle(exe string) error { return settle(exe, false) }

// Cancel is Settle for a move whatever its age: `data-directory cancel`.
func Cancel(exe string) error { return settle(exe, true) }

// settleGrace is how long a move whose helper has not taken it yet is left
// to it.
var settleGrace = time.Minute

func settle(exe string, force bool) error {
	tx, err := Status(exe)
	if err != nil || tx == nil || tx.Terminal() {
		return err
	}
	unlock, err := lockFor(exe, 200*time.Millisecond)
	if err != nil {
		return err
	}
	defer unlock()
	tx, err = Status(exe)
	if err != nil || tx == nil || tx.Terminal() {
		return err
	}
	if !force && tx.State != StateCleanup && time.Since(tx.Updated) < settleGrace {
		return ErrMoving
	}
	mode, modeErr := appdir.ReadMode(exe)
	if modeErr != nil {
		return modeErr
	}
	if tx.State == StateCleanup || (tx.State == StatePublished && mode == tx.To) {
		if mode != tx.To {
			return errors.New("cleanup record does not match the selected data directory")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		release, err := Exclusive(ctx, append(sources(tx), targets(tx)...))
		cancel()
		if err != nil {
			return nil
		} // the new root may already be in use
		defer release()
		if tx.State == StatePublished {
			if err := verifyPublished(tx); err != nil {
				tx.State, tx.Error = StateCleanup, err.Error()
				return save(exe, tx) // never restore a root after pointer commit
			}
		}
		_ = cleanup(context.Background(), exe, tx)
		return nil // startup uses the committed root and shows cleanup status
	}
	// a body still running on either place keeps it
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	release, err := Exclusive(ctx, append(sources(tx), targets(tx)...))
	cancel()
	if err != nil {
		return ErrMoving
	}
	release()
	why := "the data move was interrupted; magpie's data stayed where it was"
	if force {
		why = "the data move was cancelled; magpie's data stayed where it was"
	}
	fail(exe, tx, errors.New(why))
	return nil
}

// Roots are the folders a magpie of mode takes a lease in.
func Roots(exe, mode string) ([]string, error) {
	p, err := PlacesOf(exe, mode)
	if err != nil {
		return nil, err
	}
	roots := []string{p.Config, p.Cache}
	if !appdir.SameCachePath(p.Cache, p.SystemCache) {
		roots = append(roots, p.SystemCache)
	}
	return roots, nil
}

func contains(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

type entry struct {
	Mode fs.FileMode
	Size int64
	Hash string
}

// manifest is every file and folder of root but those skip names, by path
// in it, with each file's hash.
func manifest(root string, skip func(string) bool) (map[string]entry, error) {
	out := map[string]entry{}
	err := walk(root, skip, func(path, rel string, d fs.DirEntry, st fs.FileInfo) error {
		item := entry{Mode: st.Mode()}
		if !d.IsDir() {
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			h := sha256.New()
			_, err = io.Copy(h, f)
			f.Close()
			if err != nil {
				return err
			}
			item.Size, item.Hash = st.Size(), hex.EncodeToString(h.Sum(nil))
		}
		out[rel] = item
		return nil
	})
	return out, err
}

func sameData(a, b map[string]entry) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		w, ok := b[k]
		if !ok || v.Hash != w.Hash || v.Size != w.Size || v.Mode.IsDir() != w.Mode.IsDir() {
			return false
		}
	}
	return true
}

// walk calls f for every regular file and folder under root (not root),
// skipping what skip names. A link or a special file stops it: the move
// copies no data it can't be sure of.
func walk(root string, skip func(string) bool, f func(path, rel string, d fs.DirEntry, st fs.FileInfo) error) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) && path == root {
			return nil
		}
		if err != nil {
			return err
		}
		if path == root {
			if !d.IsDir() || d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("data root is a link or not a directory: %s", root)
			}
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if skip(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		st, err := d.Info()
		if err != nil {
			return err
		}
		if !st.IsDir() && !st.Mode().IsRegular() {
			return fmt.Errorf("%s is a link or special file, which a data move doesn't copy", path)
		}
		return f(path, rel, d, st)
	})
}

// copyTree copies root's files and folders into dst, made if missing.
func copyTree(ctx context.Context, root, dst string, skip func(string) bool) error {
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return err
	}
	var dirs []string
	err := walk(root, skip, func(path, rel string, d fs.DirEntry, st fs.FileInfo) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		if d.IsDir() {
			dirs = append(dirs, rel)
			return os.MkdirAll(to, 0o700)
		}
		return copyFile(path, to, st)
	})
	if err != nil {
		return err
	}
	// folders get their own permissions once their files are in
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, rel := range dirs {
		if st, err := os.Stat(filepath.Join(root, rel)); err == nil {
			os.Chmod(filepath.Join(dst, rel), st.Mode().Perm())
		}
	}
	return nil
}

func copyFile(from, to string, st fs.FileInfo) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Chmod(st.Mode().Perm())
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Chtimes(to, st.ModTime(), st.ModTime())
}

// webViewGone waits, d at most, until no WebView2 browser runs on the
// profile in dir: its EBWebView\lockfile can be removed, or there is none.
// A browser running on it holds the file open without sharing delete.
func webViewGone(ctx context.Context, dir string, d time.Duration) error {
	lock := filepath.Join(dir, "EBWebView", "lockfile")
	end := time.Now().Add(d)
	for {
		err := os.Remove(lock)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if time.Now().After(end) {
			return fmt.Errorf("the window's browser still holds %s: %w", lock, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(waitTick):
		}
	}
}

var waitTick = 25 * time.Millisecond

// afterPublish fails a move between its publish and its mode file: tests.
var afterPublish = func() error { return nil }
