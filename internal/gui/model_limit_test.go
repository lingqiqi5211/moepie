package gui

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

func TestSettingsDefaultModelLimit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	p := provider.Provider{ID: "limit-probe", Key: "test", Chat: "http://127.0.0.1:1/v1"}
	if err := provider.Save(p); err != nil {
		t.Fatal(err)
	}
	var ms []catalog.Model
	for i := 0; i < 60; i++ {
		ms = append(ms, catalog.Model{ID: fmt.Sprintf("model-%02d", i)})
	}
	if err := catalog.SaveLive(p.ID, p.Chat, ms); err != nil {
		t.Fatal(err)
	}
	// Hold a catalog exactly as an API request does. Its entries must change
	// before the save answers, and the Agent catalog callback must be told.
	release := provider.Hold()
	defer release()
	count := func() int {
		n := 0
		for _, e := range provider.Catalog() {
			if e.Provider.ID == p.ID {
				n++
			}
		}
		return n
	}
	if n := count(); n != 24 {
		t.Fatalf("old config exposed %d, want 24", n)
	}
	old := catalog.Changed
	calls := 0
	catalog.Changed = func() { calls++ }
	defer func() { catalog.Changed = old }()
	h := Handler(nil, nil)
	for _, tc := range []struct {
		body    string
		want    int
		invalid bool
	}{
		{`{"defaultModelLimit":48}`, 48, false}, {`{"theme":"dark"}`, 48, false},
		{`{"defaultModelLimit":3}`, 3, false}, {`{"defaultModelLimit":0}`, 60, false},
		{`{"defaultModelLimit":-1}`, 60, true}, {`{"defaultModelLimit":1.5}`, 60, true},
		{`{"defaultModelLimit":"24"}`, 60, true}, {`{"defaultModelLimit":null}`, 24, false},
	} {
		before := calls
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/settings", strings.NewReader(tc.body)))
		wantStatus := http.StatusOK
		if tc.invalid {
			wantStatus = http.StatusBadRequest
		}
		if rec.Code != wantStatus {
			t.Fatalf("%s: %d %s", tc.body, rec.Code, rec.Body)
		}
		if n := count(); n != tc.want {
			t.Fatalf("%s: cached catalog has %d, want %d", tc.body, n, tc.want)
		}
		if !tc.invalid && strings.Contains(tc.body, "defaultModelLimit") && calls <= before {
			t.Fatalf("%s did not notify Agent catalog sync", tc.body)
		}
		if tc.invalid && calls != before {
			t.Fatalf("invalid input notified catalog change")
		}
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/settings", nil))
		var got struct {
			DefaultModelLimit *int `json:"defaultModelLimit"`
			Effective         int  `json:"effectiveModelLimit"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		s := settings.Load()
		if got.Effective != s.EffectiveModelLimit() || (got.DefaultModelLimit == nil) != (s.DefaultModelLimit == nil) {
			t.Fatalf("settings GET lost limit: %s", rec.Body)
		}
		info := providerInfo(p, nil)
		if info.ModelListLimit != s.EffectiveModelLimit() {
			t.Fatalf("provider JSON limit %d, want %d", info.ModelListLimit, s.EffectiveModelLimit())
		}
	}
}
