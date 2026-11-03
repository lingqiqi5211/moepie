package usage

import (
	"fmt"
	"testing"
	"time"
	"unsafe"
)

// groupsOf is a page's groups as "id calls/swaps", and "+rows" when it
// lists more rows than it counts calls, in order.
func groupsOf(p RequestPage) string {
	s := ""
	for _, g := range p.Groups {
		s += fmt.Sprintf("%s %d/%d", g.ID, g.Calls, g.Swaps)
		if g.Rows != g.Calls {
			s += fmt.Sprintf("+%d", g.Rows)
		}
		s += ";"
	}
	return s
}

// A requests page's groups sum the whole period with the mismatch pick
// cleared, so a header says all of its group; the pick itself keeps the
// mismatched rows of the whole period, not of one page, and drops the
// groups with none. A group counts the rows it lists, a call turned away
// among them though in no sum; models group by the one asked for, and the
// rows of none have a group of their own. The ledger's own page groups
// the same.
func TestRequestPageGroupsAndMismatch(t *testing.T) {
	pageHome(t)
	now := time.Now()
	add := func(i int, agent, model, served, session string) {
		Append(Record{Time: now.Add(time.Duration(i) * time.Second), Agent: agent, Provider: "relay", Model: model, Served: served, Session: session, Input: 10, Output: 1, Status: 200})
	}
	add(0, "codex", "gpt-6", "gpt-6", "s1")
	add(1, "codex", "gpt-6", "gpt-6-mini", "s1") // another model
	add(2, "codex", "gpt-6", "", "s1")
	add(3, "opencode", "claude-sonnet-5", "claude-sonnet-5-20260801", "s2") // dated: the same one
	add(4, "opencode", "claude-sonnet-5", "", "s2")
	add(5, "opencode", "claude-sonnet-5", "gpt-6-mini", "") // another model, no session
	// turned away: listed in its groups, in none of their sums
	Append(Record{Time: now.Add(1500 * time.Millisecond), Agent: "codex", Model: "gpt-6", Session: "s1", Status: 429, Rejected: true})
	// asked for by an alias, and a call that named no model
	Append(Record{Time: now.Add(6 * time.Second), Agent: "claude-code", Provider: "relay", Requested: "sol", Model: "gpt-6", Served: "gpt-6", Session: "s3", Input: 10, Output: 1, Status: 200})
	Append(Record{Time: now.Add(7 * time.Second), Agent: "claude-code", Provider: "relay", Session: "s3", Input: 10, Output: 1, Status: 200})
	pages := map[string]func(Filter) RequestPage{
		"streamed": func(f Filter) RequestPage { return QueryPage(All, f, 0, 100) },
		"ledger":   func(f Filter) RequestPage { return pageFromLedgerAt(All, f, 0, 100, LedgerOf(All, Filter{}), Clock()) },
	}
	for name, page := range pages {
		for repeat := 0; repeat < 2; repeat++ {
			if p := page(Filter{}); p.Sum.Swaps != 2 || p.Groups != nil {
				t.Fatalf("%s: swaps %d, groups %+v", name, p.Sum.Swaps, p.Groups)
			}
			p := page(Filter{Swapped: true})
			if p.Total != 2 || p.Sum.Swaps != 2 || p.Sum.Calls != 2 {
				t.Fatalf("%s: mismatched only: total %d, %+v", name, p.Total, p.Sum)
			}
			for _, r := range p.Rows {
				if !r.Swapped || r.ServedAs(r.Model) != ServedSwapped {
					t.Fatalf("%s: kept a row that was not swapped: %+v", name, r)
				}
			}
			for _, c := range []struct {
				f    Filter
				want string
			}{
				{Filter{Group: "agent"}, "codex 3/1+4;opencode 3/1;claude-code 2/0;"},
				{Filter{Group: "model"}, "claude-sonnet-5 3/1;gpt-6 3/1+4;none 1/0;sol 1/0;"},
				// the latest session first, the calls of none last
				{Filter{Group: "session"}, "s3 2/0;s2 2/0;s1 3/1+4;none 1/1;"},
				// the headers still sum every call of a group kept
				{Filter{Group: "session", Swapped: true}, "s1 3/1+1;none 1/1;"},
				{Filter{Group: "agent", Agent: "codex"}, "codex 3/1+4;"},
			} {
				p := page(c.f)
				if got := groupsOf(p); got != c.want || p.GroupCount != len(p.Groups) {
					t.Fatalf("%s %+v: groups %q (%d), want %q", name, c.f, got, p.GroupCount, c.want)
				}
				// a group's rows are what the filter of its key lists
				for _, g := range p.Groups {
					f := c.f
					f.Group = ""
					switch c.f.Group {
					case "agent":
						f.Agent = g.ID
					case "model":
						f.Requested = g.ID
					default:
						f.Session = g.ID
					}
					if f.Swapped && g.Rows != g.Swaps {
						t.Fatalf("%s: group %s counts %d rows of %d mismatched", name, g.ID, g.Rows, g.Swaps)
					}
					if rows := page(f); rows.Total != g.Rows {
						t.Fatalf("%s: group %s lists %d rows, its header says %d", name, g.ID, rows.Total, g.Rows)
					}
				}
			}
			s1 := page(Filter{Group: "session"}).Groups[2]
			if s1.ID != "s1" || s1.First.Sub(now).Abs() > time.Second || s1.Last.Sub(now.Add(2*time.Second)).Abs() > time.Second {
				t.Fatalf("%s: s1 spans %v to %v", name, s1.First, s1.Last)
			}
		}
	}
}

func TestServedAs(t *testing.T) {
	for _, c := range []struct {
		r    Row
		want string
	}{
		{Row{Record: Record{Model: "gpt-6"}}, ""},
		{Row{Record: Record{Model: "gpt-6", Served: "GPT-6"}}, ServedSame},
		{Row{Record: Record{Model: "gpt-6", Requested: "sol", Served: "sol"}}, ServedSame},
		{Row{Record: Record{Model: "claude-sonnet-5", Served: "claude-sonnet-5-20260801"}}, ServedRenamed},
		{Row{Record: Record{Model: "gpt-6", Served: "gpt-6-mini"}, Swapped: true}, ServedSwapped},
		{Row{Record: Record{Model: "group/fast", Served: "nimbus-flash"}, Routed: true}, ServedRouted},
		{Row{Record: Record{Model: "auto", Served: "gpt-6"}}, ServedPicked},
	} {
		if got := c.r.ServedAs(c.r.Model); got != c.want {
			t.Errorf("%+v: %q, want %q", c.r.Record, got, c.want)
		}
	}
	// the flags are Swapped's and GroupRouted's verdicts, as the ledger reads them
	for _, c := range []struct{ sent, served, want string }{
		{"gpt-6", "gpt-6-mini", ServedSwapped},
		{"claude-sonnet-5", "claude-sonnet-5-20260801", ServedRenamed},
		{"group/fast", "nimbus-flash", ServedRouted},
		{"auto", "gpt-6", ServedPicked},
	} {
		r := Row{Record: Record{Model: c.sent, Served: c.served}, Swapped: Swapped(c.sent, c.served), Routed: GroupRouted(c.sent, c.served)}
		if got := r.ServedAs(c.sent); got != c.want {
			t.Errorf("%s answered as %s: %q, want %q", c.sent, c.served, got, c.want)
		}
	}
	// auto is judged on the name sent, as Swapped judges it: a model the
	// user's wires send as auto had the vendor pick, and one asked for as
	// auto but sent by another name did not
	wired := Row{Record: Record{Model: "nimbus", Served: "gpt-6"}}
	if got := wired.ServedAs("auto"); got != ServedPicked || Swapped("auto", "gpt-6") {
		t.Errorf("sent as auto: %q", got)
	}
	unwired := Row{Record: Record{Model: "auto", Served: "gpt-6"}, Swapped: Swapped("nimbus", "gpt-6")}
	if got := unwired.ServedAs("nimbus"); got != ServedSwapped {
		t.Errorf("auto sent as nimbus: %q", got)
	}
}

// A period of more sessions than a page lists keeps the latest of them and
// the calls of none, and counts every one.
func TestRequestPageGroupsCut(t *testing.T) {
	pageHome(t)
	now := time.Now().Add(-time.Hour)
	n := groupsKept + 20
	Append(Record{Time: now.Add(-time.Minute), Agent: "codex", Provider: "relay", Model: "gpt-6", Input: 1, Output: 1, Status: 200})
	for i := range n {
		// the oldest sessions have the most calls, which order agents
		// and models but not sessions
		for range 1 + (n-i)/50 {
			Append(Record{Time: now.Add(time.Duration(i) * time.Second), Agent: "codex", Provider: "relay", Model: "gpt-6", Session: fmt.Sprintf("s%03d", i), Input: 1, Output: 1, Status: 200})
		}
	}
	for name, page := range map[string]func(Filter) RequestPage{
		"streamed": func(f Filter) RequestPage { return QueryPage(All, f, 0, 100) },
		"ledger":   func(f Filter) RequestPage { return pageFromLedgerAt(All, f, 0, 100, LedgerOf(All, Filter{}), Clock()) },
	} {
		p := page(Filter{Group: "session"})
		if len(p.Groups) != groupsKept || p.GroupCount != n+1 {
			t.Fatalf("%s: %d groups of %d", name, len(p.Groups), p.GroupCount)
		}
		if first, last := p.Groups[0].ID, p.Groups[groupsKept-1].ID; first != fmt.Sprintf("s%03d", n-1) || last != NoSession {
			t.Fatalf("%s: groups from %s to %s", name, first, last)
		}
		// the latest groupsKept-1 sessions are kept, the older cut
		if at := p.Groups[groupsKept-2].ID; at != fmt.Sprintf("s%03d", n-groupsKept+1) {
			t.Fatalf("%s: the oldest session kept is %s", name, at)
		}
	}
}

// The cells of the pages used last are kept, built again or served from
// the pages kept (useParts), and those of the least recently used let go:
// a refresh of a page and its open groups, one filter each, reads none of
// them again.
func TestKeepPartsLeastRecent(t *testing.T) {
	idx := &requestIndex{}
	key := func(i int) partKey { return partKey{p: All, f: Filter{Session: fmt.Sprint(i)}} }
	for i := range partKeys {
		idx.keepParts(key(i), map[uint64]*chunkPart{})
	}
	idx.keepParts(key(0), map[uint64]*chunkPart{}) // asked for again
	idx.keepParts(key(partKeys), map[uint64]*chunkPart{})
	if len(idx.parts) != partKeys || idx.parts[key(0)] == nil || idx.parts[key(1)] != nil || idx.parts[key(partKeys)] == nil {
		t.Fatalf("kept %d sets: 0 %v, 1 %v", len(idx.parts), idx.parts[key(0)] != nil, idx.parts[key(1)] != nil)
	}
	// a page served from pages uses its cells too, which outlast those
	// built after them
	idx.useParts(key(2))
	idx.keepParts(key(partKeys+1), map[uint64]*chunkPart{})
	if idx.parts[key(2)] == nil || idx.parts[key(3)] != nil {
		t.Fatalf("after a page of 2 served: 2 %v, 3 %v", idx.parts[key(2)] != nil, idx.parts[key(3)] != nil)
	}
	idx.useParts(key(1)) // let go already: nothing to mark
	if _, ok := idx.partsUsed[key(1)]; ok {
		t.Fatal("a set let go is marked used")
	}
	// a set too big for the rest is kept alone
	old := partBytes
	partBytes = int64(unsafe.Sizeof(pageCell{})) * 10
	t.Cleanup(func() { partBytes = old })
	idx.keepParts(key(99), map[uint64]*chunkPart{1: {cells: make([]pageCell, 11)}})
	if len(idx.parts) != 1 || idx.parts[key(99)] == nil {
		t.Fatalf("kept %d sets beside one of more than partBytes", len(idx.parts))
	}
}
