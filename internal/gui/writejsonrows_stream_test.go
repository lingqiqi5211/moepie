package gui

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
)

// The writer keeps a row-sized buffer, not the entire answer. Preallocate
// the recorder so the measurement excludes the client's copy.
func TestJSONRowsNotHeldWhole(t *testing.T) {
	big := string(bytes.Repeat([]byte("x"), 64<<10))
	rows := make([]rowsBufRow, 64)
	for i := range rows {
		rows[i] = rowsBufRow{Name: big, N: float64(i)}
	}
	writeJSONRows(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil), "rows", rows, struct{}{})
	w := httptest.NewRecorder()
	w.Body.Grow(len(rows)*len(big) + 1<<20)
	r := httptest.NewRequest("GET", "/x", nil)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	writeJSONRows(w, r, "rows", rows, struct{}{})
	runtime.ReadMemStats(&after)
	answer, allocated := uint64(w.Body.Len()), after.TotalAlloc-before.TotalAlloc
	t.Logf("answer %d bytes: allocated %d bytes", answer, allocated)
	if allocated > answer/4 {
		t.Fatalf("writeJSONRows allocated %d bytes for a %d-byte answer", allocated, answer)
	}
}

func TestJSONRowsTagAndInvalidRow(t *testing.T) {
	rows := []rowsBufRow{{Name: "<session>", N: 2}}
	w := httptest.NewRecorder()
	writeJSONRows(w, httptest.NewRequest("GET", "/x", nil), "rows", rows, struct{}{})
	sum := sha256.Sum256(w.Body.Bytes())
	tag := w.Header().Get("X-Magpie-Tag")
	if tag != hex.EncodeToString(sum[:16]) {
		t.Fatalf("tag %q does not describe the response bytes", tag)
	}
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("X-Magpie-Had", tag)
	w = httptest.NewRecorder()
	writeJSONRows(w, r, "rows", rows, struct{}{})
	if w.Code != http.StatusOK || w.Body.Len() != 0 || w.Header().Get("X-Magpie-Same") != "1" || w.Header().Get("X-Magpie-Tag") != tag {
		t.Fatalf("unchanged response: status %d, headers %v, body %q", w.Code, w.Header(), w.Body.String())
	}
	rows = append(rows, rowsBufRow{N: math.NaN()})
	w = httptest.NewRecorder()
	writeJSONRows(w, httptest.NewRequest("GET", "/x", nil), "rows", rows, struct{}{})
	if w.Code != http.StatusBadRequest || w.Header().Get("X-Magpie-Tag") != "" || bytes.Contains(w.Body.Bytes(), []byte(`"rows":`)) {
		t.Fatalf("invalid row leaked a partial success: status %d, headers %v, body %q", w.Code, w.Header(), w.Body.String())
	}
}
