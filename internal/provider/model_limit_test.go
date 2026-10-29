package provider

import (
	"fmt"
	"testing"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/settings"
)

// Historical default used by the existing no-picks regression fixtures.
const manyModels = 24

func TestExposedDefaultModelLimit(t *testing.T) {
	oneHome(t)
	p := Provider{ID: "limit-probe", Key: "test", Chat: "http://127.0.0.1:1/v1"}
	var ms []catalog.Model
	// Unsupported models precede the usable ones, so filtering must happen first.
	ms = append(ms, catalog.Model{ID: "messages-only", APIs: []string{"anthropic"}})
	for i := 0; i < 60; i++ {
		ms = append(ms, catalog.Model{ID: fmt.Sprintf("model-%02d", i), APIs: []string{"chat"}})
	}
	if err := catalog.SaveLive(p.ID, p.Chat, ms); err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int{-1, 48, 3, 0} {
		s := settings.Settings{}
		if limit >= 0 {
			s.DefaultModelLimit = &limit
		}
		if err := settings.Save(s); err != nil {
			t.Fatal(err)
		}
		catalog.Touched()
		want := limit
		if limit < 0 {
			want = 24
		}
		if limit == 0 {
			want = 60
		}
		got := p.Exposed()
		if len(got) != want || got[0].ID != "model-00" {
			t.Fatalf("limit %d: exposed %d, want %d (first %v)", limit, len(got), want, got)
		}
		picked := p
		for _, m := range ms {
			picked.Models = append(picked.Models, m.ID)
		}
		if n := len(picked.Exposed()); n != 60 {
			t.Errorf("limit %d truncated explicit picks to %d", limit, n)
		}
		none := p
		none.NoModels = true
		if len(none.Exposed()) != 0 {
			t.Errorf("limit %d exposed Usage only models", limit)
		}
		remote := p
		remote.Preset = RemoteMagpiePreset
		if n := len(remote.Exposed()); n != 60 || remote.ModelListLimit() != 0 {
			t.Errorf("limit %d capped remote magpie: %d", limit, n)
		}
	}
}
