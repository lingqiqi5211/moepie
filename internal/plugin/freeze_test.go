package plugin

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/proc"
)

// A child that lives until its input closes, as Bun's host.js does.
func init() {
	if os.Getenv("MAGPIE_TEST_STDIN_CHILD") == "1" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
}

func startStdinHost(t *testing.T) *host {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := proc.Command(exe, "-test.run=^$")
	cmd.Env = append(os.Environ(), "MAGPIE_TEST_STDIN_CHILD=1")
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	hctx, hcancel := context.WithCancel(context.Background())
	h := &host{cmd: cmd, in: in, calls: map[int64]*call{}, dead: make(chan struct{}),
		exited: make(chan struct{}), slots: make(chan struct{}, 1), out: make(chan writeReq, 1),
		ctrl: map[int64]*ctrl{}, ctrlWake: make(chan struct{}, 1), ctx: hctx, cancel: hcancel}
	hostsLive.Lock()
	hostsLive.m[h] = true
	hostsLive.Unlock()
	go h.read(out)
	return h
}

// Freeze returns only once every host's process, current and retiring, is
// waited for, and keeps a new one from starting until Thaw.
func TestFreezeWaitsForEveryHost(t *testing.T) {
	a, b := startStdinHost(t), startStdinHost(t)
	hostMu.Lock()
	current = a
	retiring[b] = true
	hostMu.Unlock()
	t.Cleanup(func() {
		hostMu.Lock()
		delete(retiring, b)
		hostMu.Unlock()
		Thaw()
	})
	if err := Freeze(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	for _, h := range []*host{a, b} {
		select {
		case <-h.exited:
		default:
			t.Fatal("Freeze returned before a host's process was waited for")
		}
	}
	hostMu.Lock()
	_, err := getLocked(context.Background())
	hostMu.Unlock()
	if !errors.Is(err, errFrozen) {
		t.Fatalf("a host started while frozen: %v", err)
	}
}
