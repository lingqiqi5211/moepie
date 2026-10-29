package gateway

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// plainCompact builds only the latest text it keeps, and keeps what it did
// when it built the whole conversation first.
func TestPlainCompactKeepsTheLatest(t *testing.T) {
	for _, n := range []int{3, 40, 400} {
		var items []map[string]any
		for i := range n {
			items = append(items, map[string]any{"type": "message", "role": "user", "content": fmt.Sprintf("turn %d %s", i, strings.Repeat("x", 3000))})
		}
		input, _ := json.Marshal(items)
		body, _ := json.Marshal(map[string]json.RawMessage{"model": json.RawMessage(`"gpt-5"`), "input": input})

		var whole strings.Builder
		for _, it := range items {
			role, text := itemText(it)
			fmt.Fprintf(&whole, "[%s]\n%s\n\n", role, text)
		}
		want := whole.String()
		if len(want) > plainCompactMax {
			want = "…\n" + want[len(want)-plainCompactMax:]
		}
		var q struct {
			Input []struct {
				Content []struct{ Text string } `json:"content"`
			} `json:"input"`
		}
		if err := json.Unmarshal(plainCompact(body), &q); err != nil {
			t.Fatal(err)
		}
		if got := strings.TrimPrefix(q.Input[0].Content[0].Text, "This is the conversation so far:\n\n"); got != want {
			t.Fatalf("%d turns: kept %d bytes, want %d", n, len(got), len(want))
		}
	}
}

// A reply past recorderMost is dropped, not held, and said to be.
func TestRecorderCutsPastMost(t *testing.T) {
	rec := &recorder{}
	chunk := make([]byte, 1<<20)
	for range recorderMost>>20 + 4 {
		if n, err := rec.Write(chunk); n != len(chunk) || err != nil {
			t.Fatal(n, err)
		}
	}
	if !rec.cut || rec.body.Len() > recorderMost {
		t.Fatalf("cut %v, held %d bytes", rec.cut, rec.body.Len())
	}
}
