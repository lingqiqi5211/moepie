package plugin

import (
	"errors"
	"sync"
	"time"
)

// hostsLive are the hosts whose Bun process has not been waited for yet:
// the current one, retiring ones, and any a failure let go of before its
// process ended.
var hostsLive = struct {
	sync.Mutex
	m map[*host]bool
}{m: map[*host]bool{}}

// hostsFrozen keeps a host from being started while magpie moves its data
// directory; hostMu guards it.
var hostsFrozen bool

var errFrozen = errors.New("magpie is moving its data directory")

// Freeze stops every host, current and retiring, and waits up to timeout
// for each Bun process to be waited for; none is started until Thaw. An
// error means one may still be running: the caller thaws and gives up.
func Freeze(timeout time.Duration) error {
	hostMu.Lock()
	hostsFrozen = true
	current = nil
	hostMu.Unlock()
	hostsLive.Lock()
	var all []*host
	for h := range hostsLive.m {
		all = append(all, h)
	}
	hostsLive.Unlock()
	end := time.After(timeout)
	for _, h := range all {
		go func() {
			h.stop()
			// a host that failed before its process ended returns from
			// stop at once: kill it, then
			select {
			case <-h.exited:
			case <-time.After(stopWait):
				if h.cmd.Process != nil {
					_ = h.cmd.Process.Kill()
				}
			}
		}()
	}
	for _, h := range all {
		select {
		case <-h.exited:
		case <-end:
			return errors.New("a plugin host did not exit in time")
		}
	}
	return nil
}

// Thaw lets hosts start again.
func Thaw() {
	hostMu.Lock()
	hostsFrozen = false
	hostMu.Unlock()
	changed()
}
