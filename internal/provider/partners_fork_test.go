package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestForkDisablesPartnerDiscoveryKeepsSavedPreset(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("MAGPIE_PARTNERS", "")
	resetPartners()
	t.Cleanup(resetPartners)
	p := Partner{PresetDef: PresetDef{ID: "saved-relay", Name: "Saved relay", Chat: "https://relay.example/v1"}}
	b, err := json.Marshal(partnerCache{Partners: []Partner{p}, Seen: map[string]Partner{p.ID: p}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(partnerCacheFile()), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partnerCacheFile(), b, 0600); err != nil {
		t.Fatal(err)
	}
	if partnersSource() != "off" {
		t.Fatalf("default discovery source: %s", partnersSource())
	}
	if len(Partners()) != 0 || len(PartnersNow(time.Millisecond)) != 0 {
		t.Fatal("fork advertises cached partners")
	}
	KeepPartnersFresh(context.Background()) // off must return without polling.
	// TestMain's test default also turns discovery off, but the fork must
	// preserve the cached service definition used by an existing provider.
	if got := partnerPreset(p.ID); got == nil || got.Chat != p.Chat || got.Sponsored {
		t.Fatalf("saved provider lost its preset: %+v", got)
	}
}
