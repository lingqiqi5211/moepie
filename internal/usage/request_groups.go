package usage

import (
	"cmp"
	"slices"
	"time"
)

// RowGroup is one of a requests page's groups of rows (Filter.Group). ID is
// what the filter that lists its rows takes (agent=, requested=, session=;
// NoAgent, NoModel and NoSession for the rows with none), and its sums are
// of the whole period, the Swapped pick cleared: a header says all of its
// group while only its mismatched rows are listed. Swaps is how many those
// are.
type RowGroup struct {
	ID string `json:"id"`
	Totals
	// Rows is how many rows its filter lists: the calls turned away and
	// magpie's own probes are among them, in no sum (Calls)
	Rows int `json:"rows"`
	// Agents, Providers and Models are those its calls were of, so a header
	// can say what else the group spans
	Agents    []string `json:"agents,omitempty"`
	Providers []string `json:"providers,omitempty"`
	Models    []string `json:"models,omitempty"`
	// First and Last are its oldest and newest row's times
	First time.Time `json:"first"`
	Last  time.Time `json:"last"`
}

// groupsKept bounds the groups a page lists: the rest are counted
// (RequestPage.GroupCount), a busy period has thousands of sessions.
const groupsKept = 200

// rowGroupKey is the group r is of while grouping by by: the agent it is
// counted under, the model it asked for (the model sent, for a row that
// kept none) or its session, and a group of its own for the rows of none.
func rowGroupKey(by string, r *Row) string {
	switch by {
	case "agent":
		return cmp.Or(r.key("agent"), NoAgent)
	case "model":
		return cmp.Or(r.Requested, r.Model, NoModel)
	}
	return cmp.Or(r.Session, NoSession)
}

// rowGroups adds up a page's groups from the sums each part of them has.
type rowGroups struct {
	by   string
	m    map[string]*RowGroup
	sets map[string]*[3]map[string]bool
}

func newRowGroups(by string) *rowGroups {
	return &rowGroups{by: by, m: map[string]*RowGroup{}, sets: map[string]*[3]map[string]bool{}}
}

// add counts rows of group id, of these names, made between first and last
// (Unix ms), in it: listed is how many of them its filter lists, and d
// their sums (nil for the rows in no sum).
func (g *rowGroups) add(id, agent, prov, model string, first, last int64, listed int, d *Totals) {
	s := g.m[id]
	if s == nil {
		s = &RowGroup{ID: id}
		g.m[id] = s
		g.sets[id] = &[3]map[string]bool{{}, {}, {}}
	}
	s.Rows += listed
	if d != nil {
		s.plus(d)
	}
	set := g.sets[id]
	for i, v := range [3]string{agent, prov, model} {
		if v != "" {
			set[i][v] = true
		}
	}
	if f := time.UnixMilli(first); s.First.IsZero() || f.Before(s.First) {
		s.First = f
	}
	if l := time.UnixMilli(last); l.After(s.Last) {
		s.Last = l
	}
}

// list is the groups, with how many there are: only those with a mismatch
// while f keeps only those (Filter.Swapped), and at most groupsKept of
// them. Agents and models come the most calls first; sessions the latest
// first, as the Sessions page has them, and the rows of no session last,
// kept whatever is cut.
func (g *rowGroups) list(f Filter) ([]RowGroup, int) {
	out := make([]RowGroup, 0, len(g.m))
	for id, s := range g.m {
		if f.Swapped && s.Swaps == 0 {
			continue
		}
		set := g.sets[id]
		s.Agents, s.Providers, s.Models = sortedKeys(set[0]), sortedKeys(set[1]), sortedKeys(set[2])
		out = append(out, *s)
	}
	sessions := g.by == "session"
	none := func(r RowGroup) bool { return sessions && r.ID == NoSession }
	slices.SortFunc(out, func(a, b RowGroup) int {
		if none(a) != none(b) {
			if none(a) {
				return 1
			}
			return -1
		}
		if sessions && !a.Last.Equal(b.Last) {
			return b.Last.Compare(a.Last)
		}
		if !sessions && a.Calls != b.Calls {
			return b.Calls - a.Calls
		}
		return cmp.Compare(a.ID, b.ID)
	})
	n := len(out)
	if n > groupsKept {
		if none(out[n-1]) {
			out = append(out[:groupsKept-1], out[n-1])
		} else {
			out = out[:groupsKept]
		}
	}
	return out, n
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
