package datamove

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAdmissionDrainsExistingWorkAndRejectsNewWork(t *testing.T) {
	var a Admission
	started, finish := make(chan struct{}), make(chan struct{})
	var work atomic.Int32
	h := a.Guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/migration" {
			w.Write([]byte("waiting"))
			return
		}
		work.Add(1)
		close(started)
		<-finish
		w.Write([]byte("finished existing task"))
	}), func(r *http.Request) bool { return r.URL.Path == "/migration" })
	first := httptest.NewRecorder()
	returned := make(chan struct{})
	go func() { h.ServeHTTP(first, httptest.NewRequest("POST", "/task", nil)); close(returned) }()
	<-started
	a.Close()
	rejected := httptest.NewRecorder()
	h.ServeHTTP(rejected, httptest.NewRequest("POST", "/task", nil))
	if rejected.Code != http.StatusServiceUnavailable || work.Load() != 1 {
		t.Fatalf("new task accepted: status=%d work=%d", rejected.Code, work.Load())
	}
	state := httptest.NewRecorder()
	h.ServeHTTP(state, httptest.NewRequest("GET", "/migration", nil))
	if state.Code != 200 || strings.TrimSpace(state.Body.String()) != "waiting" {
		t.Fatal("waiting state unreachable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := a.Wait(ctx); err == nil {
		t.Fatal("drain ignored existing task")
	}
	close(finish)
	<-returned
	if err := a.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if first.Body.String() != "finished existing task" {
		t.Fatal("existing task interrupted")
	}
}
