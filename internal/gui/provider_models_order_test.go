package gui

import (
	"os"
	"slices"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// Picks the vendor's list doesn't know are shown first, the last one
// picked foremost. Adapted from upstream's provider_models_order_test.go,
// which passes its listing in: here the picks are models the catalog
// doesn't know, which is the unlisted branch the insert-all-at-once
// rewrite of that loop holds.
func TestUnlistedPicksShownFirst(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	p := provider.Provider{ID: "relay", Name: "Relay", Chat: "https://relay.example/v1", Models: []string{"x", "y", "z"}}
	info := providerInfoWith(p, nil, nil)
	var ids []string
	for _, m := range info.Models {
		ids = append(ids, m.ID)
	}
	if want := []string{"z", "y", "x"}; !slices.Equal(ids, want) {
		t.Fatalf("models shown as %v, want %v", ids, want)
	}
}
