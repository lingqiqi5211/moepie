package gateway

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

// Exercise the serving entry point: importing the probe helper alone must
// not leave production without a loop, or leave its asks alive after Serve fails.
func TestRestProbeServingLifecycle(t *testing.T) {
	for _, failure := range []bool{false, true} {
		name := "shutdown"
		if failure {
			name = "listener-failure"
		}
		t.Run(name, func(t *testing.T) {
			fresh(t)
			t.Setenv("MAGPIE_ADDR", "127.0.0.1:0")
			steps, was := restProbeSteps, listForProbe
			restProbeSteps = []time.Duration{time.Millisecond}
			started, cancelled := make(chan struct{}), make(chan struct{})
			listForProbe = func(ctx context.Context, _ provider.Provider) error {
				close(started)
				<-ctx.Done()
				close(cancelled)
				return ctx.Err()
			}
			t.Cleanup(func() { restProbeSteps, listForProbe = steps, was })
			s := New()
			stop, done := listening(t, s)
			t.Cleanup(func() {
				stop()
				untilState(t, "the serving probes to end", func() bool {
					restProbes.Lock()
					defer restProbes.Unlock()
					return !restProbes.asking[s]
				})
			})
			untilState(t, "ListenAndServe to start probes", func() bool {
				restProbes.Lock()
				defer restProbes.Unlock()
				return restProbes.asking[s]
			})
			c := probeKey(t, "probe-serving-"+name)
			r := s.restAfter(c, http.StatusServiceUnavailable, http.Header{}, []byte(outage))
			if !r.Probed {
				t.Fatal("the serving instance did not queue its outage probe")
			}
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("ListenAndServe did not run its queued probe")
			}
			if failure {
				s.lnMu.Lock()
				_ = s.ln.Close()
				s.lnMu.Unlock()
			} else {
				stop()
			}
			select {
			case err := <-done:
				if failure && err == nil {
					t.Fatal("listener failure returned no error")
				}
				if !failure && err != nil && !errors.Is(err, context.Canceled) {
					t.Fatalf("shutdown: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("serving did not finish after ending its probe")
			}
			select {
			case <-cancelled:
			default:
				t.Fatal("serving returned before its pending probe ended")
			}
			restProbes.Lock()
			asking := restProbes.asking[s]
			restProbes.Unlock()
			if asking || probeQueued(c.restKey()) {
				t.Fatal("serving left its probe loop or queue behind")
			}
		})
	}
}
