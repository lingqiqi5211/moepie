package redact

import (
	"strconv"
	"strings"
	"testing"
)

// The apps ylorn. was choosing among (Discord, 11-06) are no one's names:
// in a list of them, alone, and in the Markdown list of apps the vendor
// answered with, each goes as written though the model took it for a
// person's. Privacy Filter flagged exactly these texts (zz probe, 11-06).
func TestAppNamesNotPersons(t *testing.T) {
	apps := []string{"Cicada", "Mimi", "Phosphor", "Parakeet", "Muesli"}
	f := &fakeModel{values: map[string]string{}}
	for _, v := range apps {
		f.values[v] = "private_person"
	}
	for _, s := range []string{
		"Cicada, Mimi, Phosphor, Parakeet, Muesli",
		"Cicada and Mimi",
		"1. **Cicada** – a minimal note-taking app with Markdown.\n2. **Mimi** – a voice memo app with AI summaries.\n3. **Phosphor** – an RSS reader.\n4. **Parakeet** – a podcast player for macOS.\n5. **Muesli** – a meal planner.",
		"I switched to Muesli last week; Parakeet crashes too often.",
		"I'm using Phosphor now, and Cicada vs Mimi is still open.",
		"Apps like Muesli are hard to find.",
		"Parakeet 这个软件很好用。",
	} {
		out, _ := Mask(s, Options{Personal: true, Model: f.find})
		if out != s {
			t.Errorf("an app's name masked:\n in: %q\nout: %q", s, out)
		}
	}
}

// A person's name beside an app's is masked as before: a full name, a
// first name with a relation, a greeting or said beside it, a first name
// in a sentence of a person's doings, and a Chinese name.
func TestPersonBesideAppStillMasked(t *testing.T) {
	f := &fakeModel{values: map[string]string{
		"Mimi": "private_person", "Phosphor": "private_person", "John Smith": "private_person",
		"Cicada": "private_person", "Daniel": "private_person", "Laura": "private_person",
		"张伟": "private_person", "Parakeet": "private_person",
	}}
	for _, c := range []struct {
		s          string
		mask, keep []string
	}{
		{"My colleague Mimi said the Phosphor app is great; she uses it every day.", []string{"Mimi"}, []string{"Phosphor"}},
		{"John Smith asked me to install Cicada on his Mac.", []string{"John Smith"}, []string{"Cicada"}},
		{"张伟说 Parakeet 这个软件很好用，让我也装一个。", []string{"张伟"}, []string{"Parakeet"}},
		{"Hi Mimi, thanks for the notes from Tuesday's call. Can you send them to Laura as well?", []string{"Mimi", "Laura"}, nil},
		{"Mimi will review the draft tomorrow and send it to Daniel.", []string{"Mimi", "Daniel"}, nil},
		{"Mimi", []string{"Mimi"}, nil}, // alone it says nothing whose, and may be anyone's
	} {
		out, _ := Mask(c.s, Options{Personal: true, Model: f.find})
		for _, v := range c.mask {
			if strings.Contains(out, v) {
				t.Errorf("%q went as written:\n in: %q\nout: %q", v, c.s, out)
			}
		}
		for _, v := range c.keep {
			if !strings.Contains(out, v) {
				t.Errorf("%q masked:\n in: %q\nout: %q", v, c.s, out)
			}
		}
		if back := Restore(out, false); back != c.s {
			t.Errorf("round trip: %q", back)
		}
	}
}

// Several one-word names masked across a chat's turns come back each as
// itself, however the reply orders and splits their placeholders: restore
// never gives one name's placeholder another's value. ylorn.'s mix-up was
// not a swap here; it was the names masked in one turn and as written in
// the next (thingname.go).
func TestManyNamesRestoreEachToItself(t *testing.T) {
	names := []string{"Rosalind", "Mimi", "Torvald", "Ines", "Bartholomew", "Yuki", "Odile", "Kofi"}
	f := &fakeModel{values: map[string]string{}}
	for _, v := range names {
		f.values[v] = "private_person"
	}
	ph := map[string]string{}
	for i, v := range names {
		turn := "Hi " + v + ", my colleague " + names[(i+1)%len(names)] + " said she would call."
		out, _ := Mask(turn, Options{Personal: true, Model: f.find})
		if strings.Contains(out, v) {
			t.Fatalf("%q not masked: %q", v, out)
		}
		for _, p := range placeholderRe.FindAllString(out, -1) {
			back := Restore(p, false)
			if old, ok := ph[back]; ok && !strings.EqualFold(old, p) {
				t.Fatalf("%q masked as %s and %s", back, old, p)
			}
			ph[back] = p
		}
	}
	if len(ph) != len(names) {
		t.Fatalf("%d placeholders for %d names: %v", len(ph), len(names), ph)
	}
	// a reply naming them in reverse and in another case
	var reply, want strings.Builder
	for i := len(names) - 1; i >= 0; i-- {
		p := ph[names[i]]
		if i%2 == 0 {
			p = strings.ToLower(p)
		}
		reply.WriteString(p + " (" + names[i][:1] + "); ")
		want.WriteString(names[i] + " (" + names[i][:1] + "); ")
	}
	if got := Restore(reply.String(), false); got != want.String() {
		t.Fatalf("restored\n got %q\nwant %q", got, want.String())
	}
}

// A route may see the same text as an app description and as a tool's
// arguments. The first keeps an app's name; the second masks whom the
// tool acts for, whichever was sent first or is replayed later.
func TestSentModelKeepsToolArgumentsSeparate(t *testing.T) {
	for _, wire := range []string{"tool_use", "function_call"} {
		for _, toolFirst := range []bool{false, true} {
			for _, oneBody := range []bool{false, true} {
				name := wire + "/tool_first=" + strconv.FormatBool(toolFirst) + "/one_body=" + strconv.FormatBool(oneBody)
				t.Run(name, func(t *testing.T) {
					resetSent()
					t.Cleanup(resetSent)
					f := &fakeModel{values: map[string]string{"Rina": "private_person"}}
					o := Options{Personal: true, Model: f.find, Route: t.Name()}
					text := "install Rina"
					tool := `{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"send","input":{"note":"install Rina"}}]}`
					field := "messages"
					if wire == "function_call" {
						field = "input"
						text = `{"note":"install Rina"}`
						tool = `{"type":"function_call","call_id":"c1","name":"send","arguments":` + strconv.Quote(text) + `}`
					}
					user := `{"role":"user","content":` + strconv.Quote(text) + `}`
					first, second := user, tool
					if toolFirst {
						first, second = tool, user
					}
					bodies := []string{`{"` + field + `":[` + first + `]}`, `{"` + field + `":[` + second + `]}`}
					if oneBody {
						bodies = []string{`{"` + field + `":[` + first + `,` + second + `]}`}
					}
					for _, body := range bodies {
						out, n := MaskJSON([]byte(body), o)
						want := 0
						if strings.Contains(body, tool) {
							want = 1
						}
						if n != want || strings.Contains(body, user) && !strings.Contains(string(out), user) {
							t.Fatalf("masked %d, want %d; app description must stay as written: %s", n, want, out)
						}
						if back := RestoreJSON(out); string(back) != body {
							t.Fatalf("round trip: %s", back)
						}
						if again, _ := MaskJSON([]byte(body), o); string(again) != string(out) {
							t.Fatalf("replayed text changed: %s; was %s", again, out)
						}
					}
				})
			}
		}
	}
}

// A first name the model took for a person's goes out only where a
// thing's word is right beside it, or in a list of apps: not alone, not
// with an app's or a system's word elsewhere in its sentence, not as a
// possessive, and never in a tool call's arguments, which name whom a
// tool acts for.
func TestFirstNameNearAThingMasked(t *testing.T) {
	f := &fakeModel{values: map[string]string{"Rina": "private_person"}}
	o := Options{Personal: true, Model: f.find}
	for _, s := range []string{
		"Rina",
		"Rina's Mac won't boot",
		"Rina’s iPhone is on iOS 26",
		"Rina uses Windows at home",
		"Send the license to Rina.",
	} {
		if out, _ := Mask(s, o); strings.Contains(out, "Rina") {
			t.Errorf("went as written: %q", out)
		}
	}
	for name, body := range map[string]string{
		"user text":                      `{"messages":[{"role":"user","content":"Rina"}]}`,
		"tool_use":                       `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"send","input":{"recipient":"Rina"}}]}]}`,
		"tool_use, an app's word beside": `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"send","input":{"note":"install Rina"}}]}]}`,
		"function_call":                  `{"input":[{"type":"function_call","call_id":"c1","name":"send","arguments":"{\"recipient\":\"Rina\",\"note\":\"using Rina\"}"}]}`,
	} {
		if out, _ := MaskJSON([]byte(body), o); strings.Contains(string(out), "Rina") {
			t.Errorf("%s: went as written: %s", name, out)
		}
	}
	// an app's word right beside it still says a thing
	for _, s := range []string{"I'm using Rina now.", "the Rina app crashed"} {
		if out, _ := Mask(s, o); out != s {
			t.Errorf("an app's name masked: %q", out)
		}
	}
}
