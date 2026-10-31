package datamove

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/filelock"
)

const runtimeName = ".moepie-runtime"
const pendingName = "pending"

// strictLock never goes on without the OS lock. Higher-level filelock helpers
// intentionally fail open on filesystems without locks; migration cannot.
func strictLock(ctx context.Context, path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	for {
		held, err := filelock.TryLock(f)
		if err != nil {
			f.Close()
			return nil, err
		}
		if held {
			return func() { filelock.Unlock(f); f.Close() }, nil
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(waitTick):
		}
	}
}

// roots are the folders of dirs that exist, links followed, one for each
// that isn't inside another.
func roots(dirs []string) ([]string, error) {
	var list []string
	for _, d := range dirs {
		st, err := os.Stat(d)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !st.IsDir() {
			return nil, fmt.Errorf("data root is not a directory: %s", d)
		}
		path, err := filepath.EvalSymlinks(d)
		if err != nil {
			return nil, err
		}
		list = append(list, filepath.Clean(path))
	}
	sort.Strings(list)
	var unique []string
	for _, s := range list {
		covered := false
		for _, p := range list {
			if s != p && contains(p, s) {
				covered = true
				break
			}
		}
		if !covered && (len(unique) == 0 || unique[len(unique)-1] != s) {
			unique = append(unique, s)
		}
	}
	return unique, nil
}

func lockRoots(ctx context.Context, dirs []string) ([]string, func(), error) {
	list, err := roots(dirs)
	if err != nil {
		return nil, nil, err
	}
	var unlocks []func()
	var once sync.Once
	release := func() {
		once.Do(func() {
			for i := len(unlocks) - 1; i >= 0; i-- {
				unlocks[i]()
			}
		})
	}
	for _, root := range list {
		unlock, err := strictLock(ctx, filepath.Join(root, runtimeName, "gate"))
		if err != nil {
			release()
			return nil, nil, err
		}
		unlocks = append(unlocks, unlock)
	}
	return list, release, nil
}

// Enter registers a process before its first write to dirs: a lease the OS
// holds for as long as the process lives. A move holds the short gate
// while it waits for every lease, so none is taken meanwhile.
func Enter(ctx context.Context, dirs []string) (func(), error) {
	if len(dirs) == 0 {
		return nil, errors.New("no application data root")
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0700); err != nil {
			return nil, err
		}
	}
	list, release, err := lockRoots(ctx, dirs)
	if err != nil {
		return nil, err
	}
	defer release()
	var leases []*os.File
	var once sync.Once
	end := func() {
		once.Do(func() {
			for _, f := range leases {
				filelock.Unlock(f)
				name := f.Name()
				f.Close()
				os.Remove(name)
			}
		})
	}
	for _, root := range list {
		if b, err := os.ReadFile(filepath.Join(root, runtimeName, pendingName)); err == nil {
			end()
			return nil, fmt.Errorf("%s: %s", root, strings.TrimSpace(string(b)))
		} else if !errors.Is(err, os.ErrNotExist) {
			end()
			return nil, err
		}
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			end()
			return nil, err
		}
		f, err := os.OpenFile(filepath.Join(root, runtimeName, "run-"+hex.EncodeToString(token)), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			end()
			return nil, err
		}
		held, err := filelock.TryLock(f)
		if err != nil || !held {
			f.Close()
			end()
			return nil, fmt.Errorf("cannot register data writer: %w", err)
		}
		leases = append(leases, f)
	}
	return end, nil
}

// block marks dirs closed, why saying so to a process that would Enter one.
func block(ctx context.Context, dirs []string, why string) error {
	list, release, err := lockRoots(ctx, dirs)
	if err != nil {
		return err
	}
	defer release()
	for _, root := range list {
		if err := os.WriteFile(filepath.Join(root, runtimeName, pendingName), []byte(why+"\n"), 0600); err != nil {
			return err
		}
	}
	return nil
}

// Exclusive waits for all registered application processes to exit, keeping
// normal startup excluded. A stale lease is harmless: an ended process cannot
// hold an OS lock. OS-lock errors are returned, never treated as quiet writers.
func Exclusive(ctx context.Context, dirs []string) (func(), error) {
	list, release, err := lockRoots(ctx, dirs)
	if err != nil {
		return nil, err
	}
	for _, root := range list {
		entries, err := os.ReadDir(filepath.Join(root, runtimeName))
		if err != nil {
			release()
			return nil, err
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), "run-") {
				continue
			}
			path := filepath.Join(root, runtimeName, entry.Name())
			f, err := os.OpenFile(path, os.O_RDWR, 0)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				release()
				return nil, err
			}
			for {
				held, err := filelock.TryLock(f)
				if err != nil {
					f.Close()
					release()
					return nil, err
				}
				if held {
					filelock.Unlock(f)
					f.Close()
					break
				}
				select {
				case <-ctx.Done():
					f.Close()
					release()
					return nil, ctx.Err()
				case <-time.After(waitTick):
				}
			}
		}
	}
	return release, nil
}

func unblock(dirs []string) error {
	list, err := roots(dirs)
	if err != nil {
		return err
	}
	for _, root := range list {
		err := os.Remove(filepath.Join(root, runtimeName, pendingName))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
