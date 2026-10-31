package gui

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func TestFailSaysSignedInOnly(t *testing.T) {
	for _, only := range []bool{false, true} {
		rw := httptest.NewRecorder()
		fail(rw, fmt.Errorf("remove: %w", &provider.SignedInError{Agent: "claude", User: "synthetic@example.com", Only: only}))
		var out map[string]string
		if err := json.Unmarshal(rw.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		want := "signed_in"
		if only {
			want = "signed_in_only"
		}
		if rw.Code != 400 || out["code"] != want || out["agent"] != "claude" || out["user"] != "synthetic@example.com" || out["error"] == "" {
			t.Fatalf("only=%v: status=%d body=%v", only, rw.Code, out)
		}
	}
}
