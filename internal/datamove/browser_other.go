//go:build !windows

package datamove

import "context"

// TrackBrowserWriters precedes creation of the desktop's browser processes.
func TrackBrowserWriters() {}

func BindBrowserWriters(string, string) error { return nil }

func browserBarrier(*Transaction) (func(context.Context) error, func(), error) {
	return func(context.Context) error { return nil }, func() {}, nil
}
