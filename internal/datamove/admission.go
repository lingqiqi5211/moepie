package datamove

import (
	"context"
	"errors"
	"net/http"
	"sync"
)

// Admission closes normal application work before shutdown. Existing requests
// retain their permission until they return; state polling uses a separate route.
// A process is never allowed to change appdir's cached root in place.
type Admission struct {
	mu      sync.Mutex
	closing bool
	active  int
	changed chan struct{}
}

func (a *Admission) notify() {
	if a.changed != nil {
		close(a.changed)
	}
	a.changed = make(chan struct{})
}

func (a *Admission) Enter() (func(), error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closing {
		return nil, errors.New("data directory migration is waiting for running work to finish")
	}
	a.active++
	var once sync.Once
	return func() { once.Do(func() { a.mu.Lock(); a.active--; a.notify(); a.mu.Unlock() }) }, nil
}

func (a *Admission) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closing = true
	a.notify()
}

// Open takes work again: a move that gave up.
func (a *Admission) Open() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closing = false
	a.notify()
}

func (a *Admission) Closed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closing
}

func (a *Admission) Wait(ctx context.Context) error {
	for {
		a.mu.Lock()
		if a.active == 0 {
			a.mu.Unlock()
			return nil
		}
		if a.changed == nil {
			a.changed = make(chan struct{})
		}
		changed := a.changed
		a.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

// Business is shared by the local API and gateway. Continuations belonging to
// an admitted bridge turn must bypass this guard until that turn finishes.
var Business Admission

func (a *Admission) Guard(next http.Handler, control func(*http.Request) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if control != nil && control(r) {
			next.ServeHTTP(w, r)
			return
		}
		done, err := a.Enter()
		if err != nil {
			w.Header().Set("Retry-After", "2")
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		defer done()
		next.ServeHTTP(w, r)
	})
}
