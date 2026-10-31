package datamove

import (
	"context"
	"time"

	"github.com/yetone/magpie/internal/appdir"
)

// Mode is the place magpie run from exe uses now.
func Mode() string {
	if appdir.Portable() != "" {
		return appdir.ModePortable
	}
	return appdir.ModeInstalled
}

// Start is every start's barrier, before anything reads or writes magpie's
// data: a move left unfinished is settled, a mode file magpie can't use
// stops it, and the process takes its lease in its place for as long as it
// lives. A lease that is let go while the process can still write lets a
// move copy too early, so the caller keeps it.
func Start(exe string) (func(), error) {
	if err := Check(exe); err != nil {
		return nil, err
	}
	roots, err := Roots(exe, Mode())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return Enter(ctx, roots)
}

// Check is Start without a lease, for the short-lived helpers agents run
// (mcp, claude-mcp-helper, statusline): one held for an agent's whole
// session would keep every move waiting on it.
func Check(exe string) error {
	if err := Settle(exe); err != nil {
		return err
	}
	return appdir.CheckMode(exe)
}
