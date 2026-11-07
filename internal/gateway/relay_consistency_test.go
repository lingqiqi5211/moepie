package gateway

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// A relay may return the vendor's flat name or the client's native name.
// Restoring either spelling must preserve an explicit seal, including null.
func TestRelayNamespacedExplicitSeal(t *testing.T) {
	for _, flat := range []bool{false, true} {
		for _, seal := range []string{"missing", "null", "[]", `[{"content":"existing-seal"}]`} {
			for _, stream := range []bool{false, true} {
				name := "native"
				if flat {
					name = "flat"
				}
				t.Run(name+"/"+seal+"/stream="+map[bool]string{true: "true", false: "false"}[stream], func(t *testing.T) {
					item := map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "spawn_agent", "namespace": "collaboration", "arguments": "{}"}
					if flat {
						item["name"] = "collaboration__spawn_agent"
						delete(item, "namespace")
					}
					var want any = []any{}
					if seal != "missing" {
						if err := json.Unmarshal([]byte(seal), &want); err != nil {
							t.Fatal(err)
						}
						item["encrypted_function_args"] = want
					}
					res := map[string]any{"object": "response", "output": []any{item}}
					tidy := nsTidy{named: map[string]nsTool{"collaboration__spawn_agent": {Namespace: "collaboration", Name: "spawn_agent"}}, sse: stream}
					var raw []byte
					if stream {
						for _, typ := range []string{"response.output_item.added", "response.output_item.done", "response.completed"} {
							e := map[string]any{"type": typ, "item": item}
							if typ == "response.completed" {
								e = map[string]any{"type": typ, "response": res}
							}
							b, _ := json.Marshal(e)
							raw = append(raw, []byte("event: "+typ+"\ndata: "+string(b)+"\n\n")...)
						}
					} else {
						raw, _ = json.Marshal(res)
					}
					got := append(tidy.write(raw), tidy.flush()...)
					var items []map[string]any
					if stream {
						for _, e := range events(string(got)) {
							if it, ok := e["item"].(map[string]any); ok {
								items = append(items, it)
							} else {
								items = append(items, e["response"].(map[string]any)["output"].([]any)[0].(map[string]any))
							}
						}
					} else {
						var reply struct {
							Output []map[string]any `json:"output"`
						}
						if err := json.Unmarshal(got, &reply); err != nil {
							t.Fatal(err)
						}
						items = reply.Output
					}
					if len(items) != map[bool]int{true: 3, false: 1}[stream] {
						t.Fatalf("missing items: %s", got)
					}
					for _, it := range items {
						seal, exists := it["encrypted_function_args"]
						if it["name"] != "spawn_agent" || it["namespace"] != "collaboration" || !exists || !reflect.DeepEqual(seal, want) {
							t.Errorf("restored call lost its seal: got %#v, want %#v", it, want)
						}
					}
				})
			}
		}
	}
}

// The same text must reach a streaming client's done events, saved completed
// output, and a client reading the whole response, even when no call is added.
func TestResponsesRelayTextMatchesCompleted(t *testing.T) {
	const tag = "</｜DSML｜function_calls>"
	for _, tc := range []struct {
		name, text, want string
		native           bool
	}{
		{"native tail tags", "hello" + tag, "hello", true},
		{"native tags only", tag, "", true},
		{"tags without calls", "hello" + tag, "hello", false},
		{"only tags without calls", tag, "", false},
		{"native plain text", "hello", "hello", true},
		{"plain text", "hello", "hello", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			native := map[string]any{"type": "function_call", "id": "fc_native", "call_id": "call_native", "name": "f", "arguments": "{}", "status": "completed"}
			var lines []string
			var whole map[string]any
			send := func(e map[string]any) {
				b, _ := json.Marshal(e)
				lines = append(lines, "event: "+e["type"].(string)+"\ndata: "+string(b))
			}
			for _, e := range events(responsesSSE(tc.text)) {
				if e["type"] == "response.completed" {
					whole = e["response"].(map[string]any)
					if tc.native {
						send(map[string]any{"type": "response.output_item.added", "output_index": 1, "item": map[string]any{"type": "function_call", "id": "fc_native", "call_id": "call_native", "name": "f", "arguments": "", "status": "in_progress"}})
						send(map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_native", "output_index": 1, "delta": "{}"})
						send(map[string]any{"type": "response.function_call_arguments.done", "item_id": "fc_native", "output_index": 1, "arguments": "{}"})
						send(map[string]any{"type": "response.output_item.done", "output_index": 1, "item": native})
						whole["output"] = append(whole["output"].([]any), native)
					}
				}
				send(e)
			}
			tidy := responsesTextCalls{names: map[string]bool{"f": true}, sse: true, seq: -1}
			raw := append(tidy.write([]byte(sse(lines...))), tidy.flush()...)
			text, names, _, done, output := responsesStreamRead(t, string(raw))
			textOf := func(it map[string]any) string { return it["content"].([]any)[0].(map[string]any)["text"].(string) }
			wantItems := 1
			if tc.native {
				wantItems++
			}
			if len(done) != wantItems || len(output) != wantItems || len(names) != wantItems-1 {
				t.Fatalf("unexpected calls/items: %s", raw)
			}
			var messageDone map[string]any
			for _, it := range done {
				if it["type"] == "message" {
					messageDone = it
				}
			}
			if messageDone == nil {
				t.Fatalf("missing message.done: %s", raw)
			}
			if text != tc.want || textOf(messageDone) != tc.want || textOf(output[0]) != tc.want {
				t.Errorf("delta=%q item.done=%q completed=%q, want %q", text, textOf(messageDone), textOf(output[0]), tc.want)
			}
			counts := map[string]int{}
			for _, e := range events(string(raw)) {
				switch e["type"] {
				case "response.output_text.done":
					counts["text"]++
					if e["text"] != tc.want {
						t.Errorf("text.done=%q", e["text"])
					}
				case "response.content_part.done":
					counts["part"]++
					if e["part"].(map[string]any)["text"] != tc.want {
						t.Errorf("part.done=%v", e["part"])
					}
				}
			}
			if counts["text"] != 1 || counts["part"] != 1 {
				t.Fatalf("missing done events: %s", raw)
			}
			for _, it := range output {
				var matched map[string]any
				for _, d := range done {
					if d["id"] == it["id"] {
						matched = d
					}
				}
				if !reflect.DeepEqual(matched, it) {
					t.Errorf("item done/completed differ: %v / %v", matched, it)
				}
			}
			b, _ := json.Marshal(whole)
			wholeTidy := responsesTextCalls{names: map[string]bool{"f": true}}
			wholeOut := wholeTidy.whole(b)
			var got struct {
				Output []map[string]any `json:"output"`
			}
			if err := json.Unmarshal(wholeOut, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Output, output) {
				t.Errorf("whole output differs from completed: %s / %v", wholeOut, output)
			}
			if !strings.Contains(tc.text, "DSML") && string(wholeOut) != string(b) {
				t.Error("whole plain response changed")
			}
		})
	}
}
