package settings

import (
	"encoding/json"
	"testing"
)

func TestDefaultModelLimit(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	for _, tc := range []struct {
		body    string
		want    int
		invalid bool
	}{
		{`{}`, 24, false}, {`{"defaultModelLimit":null}`, 24, false},
		{`{"defaultModelLimit":48}`, 48, false}, {`{"defaultModelLimit":3}`, 3, false},
		{`{"defaultModelLimit":0}`, 0, false}, {`{"defaultModelLimit":-1}`, 0, true},
		{`{"defaultModelLimit":1.5}`, 0, true}, {`{"defaultModelLimit":"24"}`, 0, true},
	} {
		var s Settings
		err := json.Unmarshal([]byte(tc.body), &s)
		if err == nil {
			err = Save(s)
		}
		if tc.invalid {
			if err == nil {
				t.Errorf("accepted %s", tc.body)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", tc.body, err)
		}
		got := Load()
		if got.EffectiveModelLimit() != tc.want {
			t.Errorf("%s: got %d, want %d", tc.body, got.EffectiveModelLimit(), tc.want)
		}
		if (s.DefaultModelLimit == nil) != (got.DefaultModelLimit == nil) {
			t.Errorf("lost unset/explicit distinction: %s", tc.body)
		}
	}
}
