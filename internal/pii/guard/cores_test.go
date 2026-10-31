package guard

import (
	"strings"
	"sync"
	"testing"
)

// A panic on a goroutine the read starts is panicked again on the one
// that waits, where Find's caller recovers it: left on its own it ended
// magpie (#4553). Every part ends first.
func TestParallelCarriesAPanic(t *testing.T) {
	var ran sync.WaitGroup
	ran.Add(4)
	got := func() (r any) {
		defer func() { r = recover() }()
		parallel(4, 8, func(a, b int) {
			defer ran.Done()
			if a == 0 {
				panic("part 0")
			}
		})
		return nil
	}()
	if got != "part 0" {
		t.Fatalf("recovered %v, want part 0's panic", got)
	}
	ran.Wait()
}

// A window whose read panics (here the network's word table cut to its
// first row, so a window's ids run past it) panics on Find's caller, not
// on the window's goroutine, so the
// caller can hold back the request.
func TestFindCarriesAWindowsPanic(t *testing.T) {
	m, err := Load(dir(t))
	if err != nil {
		t.Fatal(err)
	}
	m.ml = nil
	m.net.word = m.net.word[:hidden:hidden]
	got := func() (r any) {
		defer func() { r = recover() }()
		m.Find(strings.Repeat("hello world ", 400)) // windows at once
		return nil
	}()
	if got == nil {
		t.Fatal("Find didn't panic on its caller")
	}
}
