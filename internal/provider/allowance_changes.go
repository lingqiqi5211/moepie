package provider

import (
	"sync"
	"time"
)

var allowanceChanges = struct {
	sync.RWMutex
	ch chan struct{}
}{ch: make(chan struct{})}

// AllowanceChanges wakes requests waiting for an old reset when quota cards
// change, routing's refreshed allowances land, or a reset is spent. Subscribe
// before re-reading so a concurrent refresh cannot be missed.
func AllowanceChanges() <-chan struct{} {
	allowanceChanges.RLock()
	defer allowanceChanges.RUnlock()
	return allowanceChanges.ch
}

func notifyAllowanceChanges() {
	allowanceChanges.Lock()
	close(allowanceChanges.ch)
	allowanceChanges.ch = make(chan struct{})
	allowanceChanges.Unlock()
}

// Quota cards and routing keep separate caches. A card refreshed by the user
// must make routing read it again before it decides whether to keep waiting.
func allowanceCardsChanged() {
	usedCache.Lock()
	for agent := range usedCache.at {
		usedCache.at[agent] = time.Time{}
		if usedCache.loading[agent] != nil {
			if usedCache.stale == nil {
				usedCache.stale = map[string]bool{}
			}
			usedCache.stale[agent] = true
		}
	}
	usedCache.Unlock()
	notifyAllowanceChanges()
}
