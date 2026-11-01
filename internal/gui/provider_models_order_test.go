package gui

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"

	"github.com/yetone/magpie/internal/agent"
	"github.com/yetone/magpie/internal/catalog"
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

// A row's models and agents are each made once, at their size: grown by
// append for the decision models and the picks the list lacked, and again
// to put those picks in front, it was 8 MB of what twenty polls of the
// Providers page allocated with real accounts.
func TestProviderRowListsMadeAtTheirSize(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// Bailian's plan keeps its decision model apart from its list, so one
	// row holds every kind it can: the picks the list lacks, a pick it has,
	// its models, and the decision model it lacks (or has, below).
	const base = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
	p := provider.Provider{ID: "plan", Name: "Plan", Chat: base, Decide: base,
		Models: []string{"pick-0", "pick-1", "pick-2", "pick-3", "pick-4", "pick-5", "pick-6", "m-3"}}
	var avail []catalog.Model
	for i := range 100 {
		avail = append(avail, catalog.Model{ID: fmt.Sprintf("m-%d", i)})
	}
	agents := []agentUse{{Agent: &agent.Agent{ID: "a"}}, {Agent: &agent.Agent{ID: "b"}}, {Agent: &agent.Agent{ID: "c"}}}
	for _, listed := range []bool{false, true} {
		list := append([]catalog.Model{}, avail...)
		if listed {
			// a vendor's list that names its decision model too: it is not
			// made a second time
			list[50] = catalog.Model{ID: provider.BailianDecision}
		}
		if err := catalog.SaveLive(p.ID, p.Chat, list); err != nil {
			t.Fatal(err)
		}
		info := providerInfoWith(p, agents, nil)
		var ids []string
		for _, m := range info.Models {
			ids = append(ids, m.ID)
		}
		// the picks the list lacks in front, the last one picked foremost,
		// then the vendor's list, then the decision model it lacks
		var want []string
		for i := 6; i >= 0; i-- {
			want = append(want, fmt.Sprintf("pick-%d", i))
		}
		for i := range 100 {
			id := fmt.Sprintf("m-%d", i)
			if listed && i == 50 {
				id = provider.BailianDecision
			}
			want = append(want, id)
		}
		if !listed {
			want = append(want, provider.BailianDecision)
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("listed %v: %d models, %v; want %d, %v", listed, len(ids), ids, len(want), want)
		}
		if cap(info.Models) != len(info.Models) {
			t.Fatalf("listed %v: models made for %d, %d rows: grown on the way", listed, cap(info.Models), len(info.Models))
		}
		if len(info.Agents) != 3 || cap(info.Agents) != 3 {
			t.Fatalf("agents made for %d, %d rows", cap(info.Agents), len(info.Agents))
		}
		on := map[string]bool{}
		for _, m := range info.Models {
			on[m.ID] = m.On
		}
		if !on["pick-0"] || !on["m-3"] || on["m-0"] {
			t.Fatalf("listed %v: marks %v", listed, on)
		}
		if info.Deciders == nil || !slices.Equal(*info.Deciders, []string{provider.BailianDecision}) {
			t.Fatalf("editor decisions: %v", info.Deciders)
		}
	}
}

// A row with nothing to show keeps empty lists, never null: the page reads
// models and agents as lists.
func TestProviderRowEmptyListsStillLists(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	p := provider.Provider{ID: "nothing", Name: "Nothing", Chat: "https://nothing.example/v1"}
	info := providerInfoWith(p, nil, nil)
	if len(info.Models) != 0 || cap(info.Models) != 0 || len(info.Agents) != 0 || cap(info.Agents) != 0 {
		t.Fatalf("models made for %d of %d, agents for %d of %d", cap(info.Models), len(info.Models), cap(info.Agents), len(info.Agents))
	}
	b, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["models"]) != "[]" || string(fields["agents"]) != "[]" {
		t.Fatalf("empty row: models %s, agents %s", fields["models"], fields["agents"])
	}
}
