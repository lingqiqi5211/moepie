package gateway

import (
	"encoding/json"
	"reflect"
	"testing"
)

// A pointer may name a value which is not a JSON Schema. Do not send a
// scalar or array in a Schema field; boolean schemas keep their meaning.
func TestPlainSchemaPointerTargetMustBeSchema(t *testing.T) {
	for _, tc := range []struct {
		name, target, want string
	}{
		{"number", `42`, `{"type":"object"}`},
		{"string", `"not a schema"`, `{"type":"object"}`},
		{"array", `["x"]`, `{"type":"object"}`},
		{"null", `null`, `{"type":"object"}`},
		{"true", `true`, `{}`},
		{"false", `false`, `null`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := `{"type":"object","$defs":{"target":` + tc.target + `},"properties":{"value":{"$ref":"#/$defs/target"}},"required":["value"]}`
			var got struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Required   []string                   `json:"required"`
			}
			if err := json.Unmarshal(plainSchema(json.RawMessage(in)), &got); err != nil {
				t.Fatal(err)
			}
			var value, want any
			if raw := got.Properties["value"]; raw != nil {
				if err := json.Unmarshal(raw, &value); err != nil {
					t.Fatal(err)
				}
			}
			if err := json.Unmarshal([]byte(tc.want), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(value, want) {
				t.Fatalf("value %s, want %s", got.Properties["value"], tc.want)
			}
			if (len(got.Required) != 0) != (tc.name != "false") {
				t.Fatalf("required %v", got.Required)
			}
		})
	}
}
