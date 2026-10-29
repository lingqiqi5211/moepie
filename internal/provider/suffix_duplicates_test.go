package provider

import (
	"slices"
	"testing"
)

func TestSuffixSwitchHonoursDuplicateNames(t *testing.T) {
	prefsHome(t)
	es := []Entry{
		{ID: "a/sol", Name: "Same", Default: "Sol", Provider: Provider{Name: "A"}},
		{ID: "b/sol", Name: "Same", Default: "Sol", Provider: Provider{Name: "B"}},
		{ID: "group/g", Name: "Same", Group: "g", Named: true},
	}
	for _, mode := range []string{SuffixOff, SuffixOwn} {
		if err := SetSuffixMode(mode); err != nil {
			t.Fatal(err)
		}
		if got := Labels(es); !slices.Equal(got, []string{"Same", "Same", "Same"}) {
			t.Fatalf("%s: duplicate names overrode suffix switch: %q", mode, got)
		}
	}
}
