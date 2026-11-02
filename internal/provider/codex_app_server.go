package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/proc"
)

// The Codex app greys its Send for every model, magpie's too, while the
// ChatGPT account it is signed in to is used up (its composer's gate,
// XP in ChatGPT.app 26.1013's app-primary: authMethod "chatgpt" and
// rate_limit.allowed false). It reads authMethod from its app-server's
// account/read, which answers no account once magpie is Codex's provider
// (requires_openai_auth false), but it asks only as the app-server
// starts. So when magpie becomes Codex's provider for the used-up
// account (the agent package's AppOut), and again when it puts Codex
// back on the account after its reset, magpie ends the app's own
// app-server, the one it started with: the app starts another at once,
// reads account/read again, and sends (tried in ChatGPT.app 26.1013 on
// macOS; its window, threads and drafts stay). It does that on every
// system the app runs on, with nothing for the user to do, once no Codex
// turn is running: none through magpie, none open in Codex's sessions.
//
// The same holds for every change magpie makes to where Codex sends its
// requests: a Disconnect that takes openai_base_url out, a Connect that
// puts it in, failover, the gateway moved to another port. The app-server
// read config.toml as it started, and a Codex app left running kept
// sending to 127.0.0.1:3425 after Codex was disconnected (JiangLiuer222 on
// X), so each such change restarts it the same way.
//
// A model-list-only change never restarts it: the app reads the catalog
// at its next launch or on the Agents row's Restart. Ending its app-server
// for every catalog refresh made the app relaunch every few minutes (#4550).
//
// The app-server is ended as a clean exit (proc.End): the app reads any
// other exit as a crash and shows it.

// CodexAppRoute is set by the agent package: what in Codex's config the
// app-server reads as it starts and magpie writes (its provider and base
// URL: route, compared, never parsed), and whether magpie is
// Codex's provider for its used-up ChatGPT account (out, AppOut); known
// false when Codex's config can't be read. Nothing the Codex app writes
// itself (its model or effort pick), nor the model list, is in route.
var CodexAppRoute func() (route string, out, known bool)

// codexAppEvery is how often KeepCodexAppOnItsProvider looks; codexAppIdle
// how long after Codex's last request through magpie a turn counts ended
// (a tool runs between two of a turn's requests); codexAppTries how often
// one app-server is ended before magpie says it can't.
var (
	codexAppEvery = 3 * time.Second
	codexAppIdle  = 10 * time.Second
	codexAppTries = 3
)

// codexTurnWindow is how long a session file written to last counts as a
// turn maybe still running when it has one started and not ended: a turn
// whose app-server died leaves one open for good.
const codexTurnWindow = 30 * time.Minute

// codexTurnSlack is how much earlier than the app-servers' start a turn's
// timestamp may be and still count as theirs: the two clocks are read by
// different programs.
const codexTurnSlack = 2 * time.Second

// codexAppListWait bounds one listing of the app-servers and their homes:
// at a load of 200 a 10s bound ran out on the owner's Mac (the change was
// taken up at the next look, 9s later).
const codexAppListWait = 30 * time.Second

// codexAppServersOn are the pids of the Codex app's own app-servers that
// run on the Codex home home; vars for tests.
var (
	codexAppServersOn = func(ctx context.Context, home string) ([]int, error) {
		ps, err := listProcesses(ctx)
		if err != nil {
			return nil, err
		}
		var out []int
		for _, p := range ps {
			if isCodexAppOwnServer(p.Args) && codexAppHomeIs(ctx, p.PID, home) {
				out = append(out, p.PID)
			}
		}
		return out, nil
	}
	endCodexAppServer = proc.End
	codexTurnRunning  = func(home string, now, since time.Time) bool { return codexTurnOpen(home, now, since) }
	codexServerStart  = proc.Started
)

// codexServersSince is when the oldest of the app-servers pids started: a
// turn started before it can't be running in any of them. It is zero,
// "unknown", when one's start can't be read, and every open turn counts.
func codexServersSince(pids []int) time.Time {
	var since time.Time
	for _, p := range pids {
		t, err := codexServerStart(p)
		if err != nil || t.IsZero() {
			return time.Time{}
		}
		if since.IsZero() || t.Before(since) {
			since = t
		}
	}
	return since
}

// isCodexAppOwnServer is whether a command line is the Codex app's own
// app-server, which it talks to over stdio: one another program starts
// from the app's bundled codex names where it listens (`app-server
// --listen stdio://`, Miyi Helper on macOS), and is that program's to end.
func isCodexAppOwnServer(args string) bool {
	if !isCodexAppServer(args) {
		return false
	}
	_, rest := splitExe(args)
	for _, f := range strings.Fields(rest) {
		if f == "--listen" || strings.HasPrefix(f, "--listen=") {
			return false
		}
	}
	return true
}

// codexAppHomeIs is whether app-server pid runs on Codex home home: its
// CODEX_HOME, else its HOME's .codex. A system that doesn't tell
// (Windows) counts as yes: one Codex home is the rule there.
func codexAppHomeIs(ctx context.Context, pid int, home string) bool {
	env, err := proc.EnvOf(ctx, pid, "CODEX_HOME", "HOME")
	if errors.Is(err, proc.ErrNoEnv) {
		return true
	}
	if err != nil {
		return false
	}
	h := env["CODEX_HOME"]
	if h == "" && env["HOME"] != "" {
		h = filepath.Join(env["HOME"], ".codex")
	}
	return h != "" && sameDir(h, home)
}

// sameDir is whether a and b name one folder, through links too.
func sameDir(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if a == b {
		return true
	}
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && ra == rb
}

// codexApp is what KeepCodexAppOnItsProvider knows.
var codexApp struct {
	sync.Mutex
	seen  bool
	route string
	// stale: the app-servers started before Codex's provider last changed,
	// each with how often it was ended
	stale map[int]int
	// why records the cause for each stale app-server, including account
	// switches seen by codexAppAccountSwitched, until it is ended.
	why map[int]string
	// stuck: one of them outlived codexAppTries ends, or may not be ended
	stuck bool
	// switched: Codex's ChatGPT account changed since the app-servers were
	// last listed (codexAppAccountSwitched)
	switched bool
}

// CodexAppStuck is whether a Codex app is left on the provider it started
// with, which magpie couldn't restart: the user quits and opens it.
func CodexAppStuck() bool {
	c := &codexApp
	c.Lock()
	defer c.Unlock()
	return c.stuck
}

// codexAppAccountSwitched has the Codex app's own app-servers, left on the
// ChatGPT account Codex was switched away from (noteCodexSwitch), ended
// as a route change's are, once no Codex turn runs: the app starts
// another, which reads auth.json and the new account afresh, so the app
// shows that account's limits and sends on it with no quit and reopen
// (zhibukaixinyao on Discord: Windows has no Restart button). One
// switched away and back before then is restarted all the same, which
// costs the app nothing it shows.
//
// They are listed at codexAppStep's next look, as a route change's are:
// every one on Codex's home, by the test a route change uses, and listed
// again at the look after when the listing fails. The pid the switch
// itself saw was the first app-server-looking process in a five-second
// listing, which was another program's (Miyi Helper's `--listen stdio://`
// one, listed ahead of the app's on the owner's Mac) or none when ps was
// slow, and then nothing was ended and the app stayed grey on the used-up
// account till the user restarted it (danzi002 on Discord).
func codexAppAccountSwitched() {
	c := &codexApp
	c.Lock()
	defer c.Unlock()
	c.switched = true
}

// KeepCodexAppOnItsProvider runs codexAppStep every codexAppEvery till
// ctx ends. busy says how many of Codex's requests are in flight through
// magpie and when the last ended.
func KeepCodexAppOnItsProvider(ctx context.Context, busy func() (int, time.Time)) {
	t := time.NewTicker(codexAppEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			codexAppStep(ctx, now, busy)
		}
	}
}

// codexAppStep notes the app-servers running as Codex's route changes
// (magpie becomes Codex's provider for the used-up account, or stops being
// it; Codex is connected or disconnected), and ends each of them once no
// Codex turn is running. Started with magpie on, the app may
// have opened before: its app-servers are ended too. It says which pids it
// ended.
func codexAppStep(ctx context.Context, now time.Time, busy func() (int, time.Time)) []int {
	if CodexAppRoute == nil {
		return nil
	}
	route, out, known := CodexAppRoute()
	if !known {
		return nil
	}
	home := codexHome()
	c := &codexApp
	c.Lock()
	// at the first look only a used-up account's app-servers are ended:
	// what the others read before magpie started isn't known
	changed := !c.seen && out || c.seen && c.route != route || c.switched
	if !changed {
		c.seen, c.route = true, route
	}
	c.Unlock()
	if changed {
		lctx, cancel := context.WithTimeout(ctx, codexAppListWait)
		pids, err := codexAppServersOn(lctx, home)
		cancel()
		if err != nil {
			// unknown: the change is taken up again at the next look
			log.Printf("codex: listing the Codex app's app-servers: %v", err)
			return nil
		}
		c.Lock()
		why := "where Codex's config sends it changed"
		if !c.seen {
			why = "Codex's account is used up, so magpie serves it"
		}
		if c.switched {
			why = "Codex's ChatGPT account was switched"
		}
		c.seen, c.route, c.switched = true, route, false
		c.stale, c.stuck, c.why = map[int]int{}, false, map[int]string{}
		for _, p := range pids {
			c.stale[p], c.why[p] = 0, why
		}
		c.Unlock()
	}
	c.Lock()
	n := len(c.stale)
	c.Unlock()
	if n == 0 {
		return nil
	}
	lctx, cancel := context.WithTimeout(ctx, codexAppListWait)
	pids, err := codexAppServersOn(lctx, home)
	cancel()
	if err != nil {
		return nil
	}
	running := map[int]bool{}
	for _, p := range pids {
		running[p] = true
	}
	c.Lock()
	for p := range c.stale {
		if !running[p] {
			delete(c.stale, p) // it read the provider afresh as it started
			delete(c.why, p)
		}
	}
	n = len(c.stale)
	c.Unlock()
	if n == 0 {
		return nil
	}
	if inFlight, last := busy(); inFlight > 0 || now.Sub(last) < codexAppIdle {
		return nil
	}
	c.Lock()
	stale := make([]int, 0, len(c.stale))
	for p := range c.stale {
		stale = append(stale, p)
	}
	c.Unlock()
	if codexTurnRunning(home, now, codexServersSince(stale)) {
		return nil
	}
	var ended []int
	c.Lock()
	defer c.Unlock()
	for p, tries := range c.stale {
		if tries >= codexAppTries {
			c.stuck = true
			continue
		}
		c.stale[p] = tries + 1
		if err := endCodexAppServer(p); err != nil {
			log.Printf("codex: restarting the Codex app's app-server %d on its provider: %v", p, err)
			if errors.Is(err, proc.ErrDenied) {
				c.stale[p], c.stuck = codexAppTries, true
			}
			continue
		}
		ended = append(ended, p)
		log.Printf("codex: ended the Codex app's app-server %v for the app to start another: %s", []int{p}, c.why[p])
	}
	return ended
}

// codexTurnOpen is whether a Codex session under home has a turn started
// and not ended (task_started after its last task_complete or
// turn_aborted) in a file written to within codexTurnWindow of now: the
// app-server running it would cut it short. A turn started before since,
// when the app-servers about to be ended started, ran in an app-server
// gone since (force quit, crashed): a SIGKILLed one writes no
// turn_aborted, and opening that thread again in the app writes
// thread_settings_applied, so the file stays in the window as long as
// the user looks at it. Counting it kept a switched account from ever
// reaching the app (蛋仔 on Discord, 10-29 and 10-30: "点了会话再切换账号
// 就重启不了"). A zero since counts every open turn.
func codexTurnOpen(home string, now, since time.Time) bool {
	open := false
	_ = filepath.WalkDir(filepath.Join(home, "sessions"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || open {
			if open {
				return fs.SkipAll
			}
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil || now.Sub(info.ModTime()) > codexTurnWindow {
			return nil
		}
		open = sessionTurnOpen(path, since)
		return nil
	})
	return open
}

// sessionTurnTail is how much of a session file's end sessionTurnOpen reads.
const sessionTurnTail = 512 << 10

// sessionTurnOpen is whether the session file at path ends inside a turn
// started at since or later. A file that can't be read, or a turn whose
// start can't be read, counts as open: a turn cut short costs more than
// an app greyed a few seconds more.
func sessionTurnOpen(path string, since time.Time) bool {
	f, err := os.Open(path)
	if err != nil {
		return !errors.Is(err, fs.ErrNotExist)
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil && info.Size() > sessionTurnTail {
		if _, err := f.Seek(info.Size()-sessionTurnTail, io.SeekStart); err != nil {
			return true
		}
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return true
	}
	started := bytes.LastIndex(b, []byte(`"type":"task_started"`))
	ended := max(bytes.LastIndex(b, []byte(`"type":"task_complete"`)), bytes.LastIndex(b, []byte(`"type":"turn_aborted"`)))
	if started <= ended {
		return false
	}
	if since.IsZero() {
		return true
	}
	at, ok := sessionLineTime(b, started)
	return !ok || !at.Before(since.Add(-codexTurnSlack))
}

// sessionLineTime is the "timestamp" of the session file line holding
// offset i of b, which Codex writes on every rollout line.
func sessionLineTime(b []byte, i int) (time.Time, bool) {
	line := b[bytes.LastIndexByte(b[:i], '\n')+1:]
	if j := bytes.IndexByte(line, '\n'); j >= 0 {
		line = line[:j]
	}
	var l struct {
		Timestamp time.Time `json:"timestamp"`
	}
	if json.Unmarshal(line, &l) != nil || l.Timestamp.IsZero() {
		return time.Time{}, false
	}
	return l.Timestamp, true
}

// codexAppGoneWait is how long RestartCodexApp waits for the app-servers
// it ended to be gone; a var for tests.
var codexAppGoneWait = 10 * time.Second

// RestartCodexApp restarts the app-server the Codex desktop app at bundle
// (/Applications/ChatGPT.app) runs for itself, as codexAppStep does: it is
// ended as a clean exit, and the app starts another, which reads Codex's
// config and model list afresh, while the app's window, threads and drafts
// stay as they are. The Agents row's Restart quit the app and opened it
// again, which opened a new window (yoshi037070 on Discord, 10-27). An
// app-server another program runs from the bundle (--listen) is left
// alone. It waits until the ones ended are gone, and errs when none ran.
func RestartCodexApp(ctx context.Context, bundle string) error {
	ps, err := listProcesses(ctx)
	if err != nil {
		return err
	}
	in := strings.TrimSuffix(bundle, "/") + "/Contents/"
	var ended []int
	for _, p := range ps {
		if !strings.HasPrefix(strings.TrimSpace(p.Args), in) || !isCodexAppOwnServer(p.Args) {
			continue
		}
		if err := endCodexAppServer(p.PID); err != nil {
			return err
		}
		ended = append(ended, p.PID)
	}
	if len(ended) == 0 {
		return errors.New("the Codex app's app-server isn't running")
	}
	end := time.Now().Add(codexAppGoneWait)
	for {
		ps, err := listProcesses(ctx)
		if err == nil && !slices.ContainsFunc(ps, func(p proc.Process) bool { return slices.Contains(ended, p.PID) }) {
			return nil
		}
		if time.Now().After(end) {
			return errors.New("the Codex app's app-server didn't end")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// codexAppBackWait is how long RestartSwitchedCodexApp waits for the Codex
// app to start a new app-server after the old one ended; a var for tests.
var codexAppBackWait = 20 * time.Second

// What RestartSwitchedCodexApp found when it couldn't restart the app's
// app-server; the agent package says each in the reader's language.
var (
	ErrCodexAppGone    = errors.New("the Codex app isn't running")
	ErrCodexAppNoEnd   = errors.New("the Codex app's app-server couldn't be ended")
	ErrCodexAppNotBack = errors.New("the Codex app didn't start another app-server")
)

// RestartSwitchedCodexApp is the Restart on Codex's accounts' "the Codex
// app is still signed in as" notice (nb5p_hQ on X): it restarts the app's
// own app-servers now, as codexAppStep does once no Codex turn runs, so
// the app reads the account Codex was switched to; the user said yes to
// cutting a running turn short. Each is ended as a clean exit, which the
// app answers by starting another (its window, threads and drafts stay;
// quitting the app and opening it again opened a new window, yoshi037070);
// it is never killed, as the app shows a kill as a crash. It waits until
// the ended ones are gone and a new one runs, and errs when either doesn't
// happen in time: a listing that fails is unknown, never success.
func RestartSwitchedCodexApp(ctx context.Context) error {
	home := codexHome()
	list := func() ([]int, error) {
		lctx, cancel := context.WithTimeout(ctx, codexAppListWait)
		defer cancel()
		return codexAppServersOn(lctx, home)
	}
	pids, err := list()
	if err != nil {
		return err
	}
	if len(pids) == 0 {
		DismissCodexApp()
		return ErrCodexAppGone
	}
	for _, p := range pids {
		if err := endCodexAppServer(p); err != nil {
			log.Printf("codex: restarting the Codex app's app-server %d for the account switched to: %v", p, err)
			return ErrCodexAppNoEnd
		}
	}
	// waitFor lists the app-servers until ok holds of them, for at most limit
	waitFor := func(limit time.Duration, ok func([]int) bool) (bool, error) {
		end := time.Now().Add(limit)
		for {
			now, err := list()
			if err == nil && ok(now) {
				return true, nil
			}
			if time.Now().After(end) {
				return false, err
			}
			select {
			case <-ctx.Done():
				return false, ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
	gone, err := waitFor(codexAppGoneWait, func(now []int) bool {
		return !slices.ContainsFunc(now, func(p int) bool { return slices.Contains(pids, p) })
	})
	if !gone {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			return err
		}
		return ErrCodexAppNoEnd
	}
	back, err := waitFor(codexAppBackWait, func(now []int) bool { return len(now) > 0 })
	if !back {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			return err
		}
		return ErrCodexAppNotBack
	}
	DismissCodexApp()
	return nil
}

// RestartCodexAppWhenIdle ends the Codex app's own app-servers once, for a magpie
// that won't be running to watch them (magpie uninstall): the app starts
// a new one, which reads Codex's config as it is now. It waits up to wait
// for a running Codex turn to end, and cuts none short: left says an
// app-server was still on the old config when it gave up, or couldn't be
// ended, so the user quits and opens the app.
func RestartCodexAppWhenIdle(ctx context.Context, wait time.Duration) (ended int, left bool, err error) {
	home := codexHome()
	lctx, cancel := context.WithTimeout(ctx, codexAppListWait)
	pids, err := codexAppServersOn(lctx, home)
	cancel()
	if err != nil || len(pids) == 0 {
		return 0, false, err
	}
	until := time.Now().Add(wait)
	since := codexServersSince(pids)
	for codexTurnRunning(home, time.Now(), since) {
		if time.Now().After(until) {
			return 0, true, nil
		}
		select {
		case <-ctx.Done():
			return 0, true, ctx.Err()
		case <-time.After(codexAppEvery):
		}
	}
	for _, p := range pids {
		if err := endCodexAppServer(p); err != nil {
			log.Printf("codex: restarting the Codex app's app-server %d: %v", p, err)
			left = true
			continue
		}
		ended++
	}
	return ended, left, nil
}
