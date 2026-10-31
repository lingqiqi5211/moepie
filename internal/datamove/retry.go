package datamove

import (
	"context"
	"time"
)

// RetryCleanup authorizes the same helper after the new window has drained
// requests and stopped its children. It never prepares another copy or changes
// the committed mode. The helper still waits for this window's lease to end.
func RetryCleanup(ctx context.Context, exe string) (*Transaction, error) {
	unlock, err := lockFor(exe, 5*time.Second)
	if err != nil {
		return nil, err
	}
	defer unlock()
	tx, err := Status(exe)
	if err != nil {
		return nil, err
	}
	if tx == nil || tx.State != StateCleanup {
		return nil, ErrNoMove
	}
	if err := block(ctx, append(sources(tx), targets(tx)...), "magpie is retrying old data cleanup"); err != nil {
		unblock(targets(tx))
		return nil, err
	}
	tx.Helper = 0
	tx.Quiesced = true
	if err := save(exe, tx); err != nil {
		unblock(targets(tx))
		return nil, err
	}
	return tx, nil
}
