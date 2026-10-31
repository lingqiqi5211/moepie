package proc

import (
	"errors"
	"os/exec"
	"sync"
	"time"
)

// A Tree is a started command and the processes it starts in turn: an
// agent's CLI with the MCP servers, shells and helpers it runs. Killing the
// CLI alone leaves those running, so they are ended with it.
type Tree struct {
	cmd *exec.Cmd

	mu      sync.Mutex
	done    bool            // waited for: its pid may be another process's now
	waited  chan struct{}   // closed once Wait has
	stopped chan struct{}   // Stop's, closed once it has ended the tree
	swept   <-chan struct{} // closed once Wait's sweep is done
	group
}

// StartTree starts cmd in a group of its own: a session on Unix, a job on
// Windows. It has no terminal then, and a Ctrl+C there doesn't reach it.
func StartTree(cmd *exec.Cmd) (*Tree, error) {
	ownGroup(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	t := &Tree{cmd: cmd, waited: make(chan struct{})}
	t.join(cmd)
	return t, nil
}

// Wait waits for the command, then ends what it left running.
func (t *Tree) Wait() error {
	err := t.cmd.Wait()
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.done {
		t.done = true
		t.swept = t.sweep(t.cmd)
		close(t.waited)
	}
	return err
}

// errLive is a tree Ended couldn't see the end of.
var errLive = errors.New("the process tree is still running")

// Ended waits up to timeout for the tree to have been waited for and none
// of its group left: a job with no active process on Windows, a process
// group no signal reaches on Unix. A data move waits on it before taking
// files away from under any of it. Without a job (one couldn't be made) it
// is the command's own exit.
func (t *Tree) Ended(timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-t.waited:
	case <-timer.C:
		return errLive
	}
	t.mu.Lock()
	swept := t.swept
	t.mu.Unlock()
	select {
	case <-swept:
	case <-timer.C:
		return errLive
	}
	if t.alive(t.cmd) {
		return errLive
	}
	return nil
}

// Kill ends the command and every process of its tree.
func (t *Tree) Kill() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return
	}
	_ = t.kill(t.cmd)
	_ = t.cmd.Process.Kill()
}

// Stop asks the command to end, so it can clean up first, and ends its tree
// once it has (Wait sweeps what it left) or grace has passed (Kill). Claude
// Code holding its OAuth refresh lock removes it as it exits on SIGTERM, and
// a SIGKILL left ~/.claude/.oauth_refresh.lock behind for every later
// request to wait on (#2195). Windows has no such signal: the tree is killed
// at once there. It returns at once; the channel closes once the tree is
// ended. A tree no one Waits for is killed after grace.
func (t *Tree) Stop(grace time.Duration) <-chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped != nil {
		return t.stopped
	}
	t.stopped = make(chan struct{})
	if t.done || t.term(t.cmd) != nil {
		if !t.done {
			_ = t.kill(t.cmd)
			_ = t.cmd.Process.Kill()
		}
		close(t.stopped)
		return t.stopped
	}
	go func() {
		defer close(t.stopped)
		select {
		case <-t.waited:
		case <-time.After(grace):
			t.Kill()
		}
	}()
	return t.stopped
}
