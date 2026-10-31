package library

import (
	"errors"
	"time"
)

// StopMCP ends every MCP server magpie started, the hub's and the run
// sessions', and waits up to timeout for each one's process tree to be
// gone. An error means one may still hold files: a data move gives up.
func StopMCP(timeout time.Duration) error {
	var ends []func(time.Duration) error
	hubPool.Lock()
	for _, b := range hubPool.m {
		b.mu.Lock()
		if c, ok := b.conn.(*streamConn); ok && c.ended != nil {
			ends = append(ends, c.ended)
		}
		b.mu.Unlock()
	}
	hubPool.Unlock()
	hubStopAll()

	runs.Lock()
	var sessions []*runSession
	for _, s := range runs.sessions {
		sessions = append(sessions, s)
	}
	runs.Unlock()
	for _, s := range sessions {
		if c := s.running(); c != nil {
			ends = append(ends, c.tree.Ended)
		}
		s.stop()
	}

	deadline := time.Now().Add(timeout)
	for _, ended := range ends {
		if ended(time.Until(deadline)) != nil {
			return errors.New("an MCP server did not exit in time")
		}
	}
	return nil
}
