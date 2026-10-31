package provider

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/settings"
)

// Listed IDs name vendor models directly. Reusing another vendor model's
// ID, and then exchanging their names, must preserve each model's price.
func TestListPriceFollowsAListedModelID(t *testing.T) {
	localIDHome(t)
	if err := os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(catalog.CachePath(), []byte(`{
	  "xai":{"id":"xai","models":{
	    "grok-4.6":{"id":"grok-4.6","cost":{"input":2,"output":6,"cache_read":0.5}},
	    "grok-4.6@500k":{"id":"grok-4.6@500k","cost":{"input":7,"output":9,"cache_read":1}}
	  }}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	catalog.Reset()
	t.Cleanup(catalog.Reset)
	first := catalog.Price{Input: 2, Output: 6, CacheRead: 0.5}
	second := catalog.Price{Input: 7, Output: 9, CacheRead: 1}
	check := func(want map[string]catalog.Price) {
		t.Helper()
		p := findProvider(t, "relay-a")
		for id, price := range want {
			if got, ok := p.ListPrice(id); !ok || !got.Same(price) {
				t.Errorf("ListPrice(%q) = %+v, %v; want %+v", id, got, ok, price)
			}
		}
	}
	check(map[string]catalog.Price{"grok-4.6": first, "grok-4.6@500k": second})
	setID(t, "relay-a/grok-4.6", "my-grok")
	setID(t, "relay-a/grok-4.6@500k", "grok-4.6")
	check(map[string]catalog.Price{"my-grok": first, "grok-4.6": second})
	setID(t, "relay-a/my-grok", "grok-4.6@500k")
	check(map[string]catalog.Price{"grok-4.6@500k": first, "grok-4.6": second})
}

func TestListPriceVendorLookupsDoNotResolveListedIDsAgain(t *testing.T) {
	azureHome(t)
	if err := os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(catalog.CachePath(), []byte(`{
	  "xai":{"id":"xai","models":{
	    "grok-4.7":{"id":"grok-4.7","cost":{"input":2,"output":6}},
	    "grok-4.8":{"id":"grok-4.8","cost":{"input":7,"output":9}}
	  }},
	  "openai":{"id":"openai","models":{
	    "gpt-5.5":{"id":"gpt-5.5","cost":{"input":2,"output":6}}
	  }}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	catalog.Reset()
	t.Cleanup(catalog.Reset)
	ids := map[string]string{
		"grok/grok-4.7":   "grok-4.7-build-fast",
		"factory/gpt-5.5": "gpt-5.5-fast",
	}
	for _, id := range []string{"remote", "cline", "kilo", PluginID("price-fixture")} {
		ids[id+"/grok-4.7"], ids[id+"/grok-4.8"] = "grok-4.8", "grok-4.7"
	}
	if err := settings.Save(settings.Settings{ModelIDs: ids}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		p    Provider
		want map[string]catalog.Price
	}{
		{Provider{ID: "remote", Preset: RemoteMagpiePreset, Chat: "https://remote.example.invalid/v1"}, map[string]catalog.Price{"grok-4.7": {Input: 70, Output: 90}, "grok-4.8": {Input: 20, Output: 60}}},
		{Provider{ID: "cline", Chat: "https://api.cline.bot/v1"}, map[string]catalog.Price{"grok-4.7": {Input: 7, Output: 9}, "grok-4.8": {}}},
		{Provider{ID: "kilo", Chat: "https://api.kilo.ai/v1"}, map[string]catalog.Price{"grok-4.7": {Input: 7, Output: 9}, "grok-4.8": {}}},
		{Provider{ID: "grok", Account: &Account{Agent: "grok"}}, map[string]catalog.Price{"grok-4.7": {Input: 4, Output: 12}}},
		{Provider{ID: "factory", Account: &Account{Agent: "factory"}}, map[string]catalog.Price{"gpt-5.5": {Input: 5, Output: 15}}},
	} {
		t.Run(tc.p.ID, func(t *testing.T) {
			if err := catalog.SaveLive(tc.p.ID, tc.p.Chat, []catalog.Model{
				{ID: "grok-4.7", Free: true, Price: &catalog.Price{Input: 20, Output: 60}},
				{ID: "grok-4.8", Price: &catalog.Price{Input: 70, Output: 90}},
			}); err != nil {
				t.Fatal(err)
			}
			for id, want := range tc.want {
				if got, ok := tc.p.ListPrice(id); !ok || !got.Same(want) {
					t.Errorf("%s ListPrice(%q) = %+v, %v; want %+v", tc.p.ID, id, got, ok, want)
				}
			}
		})
	}
	pp := plugin.Provider{ID: "price-fixture", Models: []plugin.Model{
		{ID: "grok-4.7", Name: "First", Free: true},
		{ID: "grok-4.8", Name: "Second", Cost: &plugin.Cost{Input: 7, Output: 9}},
	}}
	if got, ok := pluginModel(pp, "grok-4.7"); !ok || got.Name != "Second" {
		t.Errorf("listed plugin model = %+v, %v; want Second", got, ok)
	}
	if got, ok := pluginOwnModel(pp, "grok-4.7"); !ok || got.Name != "First" {
		t.Errorf("vendor plugin model = %+v, %v; want First", got, ok)
	}
}
