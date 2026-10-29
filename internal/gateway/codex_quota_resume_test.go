package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/provider"
)

func quotaResumeTest(t *testing.T) {
	t.Helper()
	codexSignedIn(t, "spare@example.com")
	oldMax, oldPause := codexQuotaResumeMax, retryPause
	codexQuotaResumeMax, retryPause = 3*time.Second, time.Millisecond
	t.Cleanup(func() { codexQuotaResumeMax, retryPause = oldMax, oldPause })
}

func quotaReply(w http.ResponseWriter) {
	w.WriteHeader(http.StatusTooManyRequests)
	io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":1}}`)
}

func quotaPong(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, sse(
		`data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.5"}}`,
		`data: {"type":"response.output_text.delta","delta":"pong"}`,
		`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":7,"output_tokens":1}}}`))
}

func quotaBackend(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	up := httptest.NewServer(handler)
	t.Cleanup(up.Close)
	old := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = old })
}

// A pool already resting is reduced to one probe. Its one remaining candidate
// must still be able to wait and resume the original pool.
func TestCodexQuotaResumeAfterSingleProbe(t *testing.T) {
	quotaResumeTest(t)
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		if asks.Add(1) == 1 {
			quotaReply(w)
			return
		}
		quotaPong(w)
	})
	p, err := provider.Find("codex")
	if err != nil {
		t.Fatal(err)
	}
	s := New()
	cs, _ := s.plan(*p, "gpt-5.5", provider.Responses)
	if len(cs) != 2 {
		t.Fatalf("pool: %d accounts", len(cs))
	}
	for _, c := range cs {
		s.restAfter(c, 429, nil, []byte(`{"error":{"type":"usage_limit_reached","resets_in_seconds":1}}`))
	}
	code, body := codexPost(t, `{"model":"gpt-5.5","stream":true,"input":"ping"}`)
	if code != 200 || !strings.Contains(body, "pong") || asks.Load() != 2 {
		t.Fatalf("single probe did not resume: status=%d asks=%d body=%s", code, asks.Load(), body)
	}
}

// A transport failure can rest a nearly spent account until its allowance
// window resets. Its "other/window" rest must not veto a pool's quota wait.
func TestCodexQuotaResumeWithWindowRest(t *testing.T) {
	quotaResumeTest(t)
	reset := time.Now().Add(time.Second)
	old := allowances
	t.Cleanup(func() { allowances = old })
	allowances = func(string) map[string]provider.Allowance {
		used := 98.0
		if !time.Now().Before(reset) {
			used = 0
		}
		return map[string]provider.Allowance{
			"me@example.com":    {{Used: 100, Resets: reset, Span: 5 * time.Hour}},
			"spare@example.com": {{Used: used, Resets: reset.Add(time.Second), Span: 5 * time.Hour}},
		}
	}
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		asks.Add(1)
		if time.Now().Before(reset) {
			quotaReply(w)
			return
		}
		quotaPong(w)
	})
	p, err := provider.Find("codex")
	if err != nil {
		t.Fatal(err)
	}
	s := New()
	cs, _ := s.plan(*p, "gpt-5.5", provider.Responses)
	if len(cs) != 2 {
		t.Fatalf("pool: %d accounts", len(cs))
	}
	for _, c := range cs {
		if c.p.Account.User == "spare@example.com" {
			rest := s.restAfter(c, 502, nil, []byte(`upstream EOF`))
			if rest.Why != failOther || rest.By != "window" {
				t.Fatalf("wanted the reporter's other/window rest, got %+v", rest)
			}
		} else {
			s.restAfter(c, 429, nil, []byte(`{"error":{"type":"usage_limit_reached","resets_in_seconds":1}}`))
		}
	}
	code, body := codexPost(t, `{"model":"gpt-5.5","stream":true,"input":"ping"}`)
	if code != 200 || !strings.Contains(body, "pong") || asks.Load() < 2 {
		t.Fatalf("mixed window rest ended the request: status=%d asks=%d body=%s", code, asks.Load(), body)
	}
}

func TestCodexQuotaWaitDoesNotHideOtherFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		used   float64
	}{
		{"invalid login", http.StatusUnauthorized, 98},
		{"forbidden", http.StatusForbidden, 98},
		{"transport failure with allowance left", http.StatusBadGateway, 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			quotaResumeTest(t)
			capUsage(t, map[string]float64{"me@example.com": 100, "spare@example.com": tc.used})
			p, err := provider.Find("codex")
			if err != nil {
				t.Fatal(err)
			}
			s := New()
			cs, _ := s.plan(*p, "gpt-5.5", provider.Responses)
			if len(cs) != 2 {
				t.Fatalf("pool: %d accounts", len(cs))
			}
			for _, c := range cs {
				if c.p.Account.User == "spare@example.com" {
					s.restAfter(c, tc.status, nil, []byte(`upstream failure`))
				} else {
					s.restAfter(c, 429, nil, []byte(`{"error":{"type":"usage_limit_reached","resets_in_seconds":1}}`))
				}
			}
			if at, wait := codexQuotaBack(cs); wait {
				t.Fatalf("unrelated failure entered quota wait until %s", at)
			}
		})
	}
}

func mixedQuotaRequest(t *testing.T, s *Server) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(
		`{"model":"group/quota-resume","stream":true,"input":"ping"}`)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer magpie-codex")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func quotaRelay(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	up := httptest.NewServer(handler)
	t.Cleanup(up.Close)
	if err := provider.Save(provider.Provider{
		ID: "relay", Name: "Relay", Key: "test", Models: []string{"m"}, Responses: up.URL + "/v1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := provider.SaveGroup(provider.Group{
		ID: "quota-resume", Name: "Quota resume",
		Members: []string{"codex/gpt-5.5", "relay/m"}, Routing: provider.Ordered, Patience: -1,
	}); err != nil {
		t.Fatal(err)
	}
}

// Quota recovery still applies after the final candidate is a third-party
// relay: the Codex accounts remain the same request's first choice when back.
func TestCodexQuotaResumeWithFailedRelay(t *testing.T) {
	quotaResumeTest(t)
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		if asks.Add(1) <= 2 {
			quotaReply(w)
			return
		}
		quotaPong(w)
	})
	quotaRelay(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, `{"error":{"message":"upstream EOF"}}`)
	})
	code, body := mixedQuotaRequest(t, New())
	if code != 200 || !strings.Contains(body, "pong") {
		t.Fatalf("mixed route did not resume: status=%d asks=%d body=%s", code, asks.Load(), body)
	}
}

// A relay with no response must not monopolize the request past a known
// official quota reset. Its attempt is canceled, not the client's request.
func TestCodexQuotaResumePreemptsSilentRelay(t *testing.T) {
	quotaResumeTest(t)
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		if asks.Add(1) <= 2 {
			quotaReply(w)
			return
		}
		quotaPong(w)
	})
	relayCanceled := make(chan struct{})
	quotaRelay(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		<-r.Context().Done()
		close(relayCanceled)
	})
	code, body := mixedQuotaRequest(t, New())
	if code != 200 || !strings.Contains(body, "pong") {
		t.Fatalf("silent relay blocked recovery: status=%d asks=%d body=%s", code, asks.Load(), body)
	}
	select {
	case <-relayCanceled:
	case <-time.After(5 * time.Second):
		t.Fatal("relay request was not canceled after switching back")
	}
}

// A real SSE event, unlike a comment, resets Codex's stream idle timeout.
// It carries no assistant text, response id, tool call or completion.
func TestCodexQuotaHeartbeatIsAnEvent(t *testing.T) {
	rec := httptest.NewRecorder()
	h := newHoldWriter(rec, true)
	h.alive = &keptAlive{proto: provider.Responses, streams: true, events: true}
	h.keepAlive()
	body := rec.Body.String()
	if !strings.Contains(body, "data: {\"type\":\"magpie.keepalive\"}\n\n") {
		t.Fatalf("Codex receives only a comment, not an event: %q", body)
	}
	for _, forbidden := range []string{"output_text", "response.created", "response.completed", "tool_call"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("heartbeat invents response content: %q", body)
		}
	}
}

func TestCodexQuotaResumeHonorsAccountLimit(t *testing.T) {
	quotaResumeTest(t)
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		if got := r.Header.Get("chatgpt-account-id"); got != "acct-2" {
			t.Errorf("request escaped key's account limit: %q", got)
		}
		if asks.Add(1) == 1 {
			quotaReply(w)
			return
		}
		quotaPong(w)
	})
	keys, secrets := newCaller(t, "Only spare")
	if _, err := access.Update("accounts-key", access.Change{
		Key: keys[0].ID, Accounts: []string{"codex/spare@example.com"},
	}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(
		`{"model":"codex/gpt-5.5","stream":true,"input":"ping"}`))
	req.Header.Set("Authorization", "Bearer "+secrets[0])
	rec := httptest.NewRecorder()
	New().Handler().ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "pong") || asks.Load() != 2 {
		t.Fatalf("restricted account did not resume: %d asks=%d %s", rec.Code, asks.Load(), rec.Body.String())
	}
}

func TestCodexQuotaResumeDoesNotReplaceReplyInProgress(t *testing.T) {
	quotaResumeTest(t)
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		asks.Add(1)
		quotaReply(w)
	})
	quotaRelay(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, sse(
			`data: {"type":"response.created","response":{"id":"relay"}}`,
			`data: {"type":"response.output_text.delta","delta":"relay answer"}`))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			return
		case <-time.After(1500 * time.Millisecond):
		}
		io.WriteString(w, sse(`data: {"type":"response.completed","response":{"id":"relay","status":"completed"}}`))
	})
	code, body := mixedQuotaRequest(t, New())
	if code != 200 || !strings.Contains(body, "relay answer") || asks.Load() != 2 ||
		strings.Count(body, `"type":"response.created"`) != 1 {
		t.Fatalf("reply replaced after content: %d asks=%d %s", code, asks.Load(), body)
	}
}

func TestCodexQuotaResumeStopsWhenClientLeaves(t *testing.T) {
	quotaResumeTest(t)
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		asks.Add(1)
		quotaReply(w)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	quotaRelay(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		cancel()
	})
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(
		`{"model":"group/quota-resume","stream":true,"input":"ping"}`)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer magpie-codex")
	s := New()
	s.Handler().ServeHTTP(httptest.NewRecorder(), req)
	if got := lastRoute(s); got.Status != 499 || asks.Load() != 2 {
		t.Fatalf("canceled request resumed: status=%d asks=%d", got.Status, asks.Load())
	}
}

func TestCodexQuotaHeartbeatDoesNotSplitPartialUpstreamFrame(t *testing.T) {
	rec := httptest.NewRecorder()
	h := newHoldWriter(rec, true)
	h.alive = &keptAlive{proto: provider.Responses, streams: true, events: true}
	h.passing = true
	h.pulse()
	if got := rec.Body.String(); got != ": keepalive\n" {
		t.Fatalf("data event inserted into an in-progress upstream frame: %q", got)
	}
}

// A refreshed allowance can recover hours before the reset promised by a
// refusal. The original request must wake even though no account was added.
func TestCodexQuotaResumeAfterEarlyRenewal(t *testing.T) {
	quotaResumeTest(t)
	codexQuotaResumeMax = 3 * time.Hour
	var recovered atomic.Bool
	provider.LoginUsageVia(func(context.Context, string) map[string]provider.SubscriptionQuota {
		used := 100.0
		if recovered.Load() {
			used = 0
		}
		reset := time.Now().Add(2 * time.Hour)
		q := provider.SubscriptionQuota{Provider: "codex", Windows: []provider.QuotaWindow{
			{Name: "5 hours", Used: used, ResetsAt: &reset, Span: 5 * time.Hour},
		}}
		return map[string]provider.SubscriptionQuota{"me@example.com": q, "spare@example.com": q}
	})
	t.Cleanup(func() { provider.LoginUsageVia(nil) })
	provider.StaleAllowance("codex", "me@example.com")
	if !provider.AwaitAllowance(context.Background(), "codex", "me@example.com") {
		t.Fatal("initial full allowance was not read")
	}
	var asks atomic.Int32
	quotaBackend(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		asks.Add(1)
		if !recovered.Load() {
			w.WriteHeader(429)
			io.WriteString(w, `{"error":{"type":"usage_limit_reached","resets_in_seconds":7200}}`)
			return
		}
		quotaPong(w)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(
		`{"model":"gpt-5.5","stream":true,"input":"ping"}`)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer chatgpt-token")
	req.Header.Set("chatgpt-account-id", "acct-1")
	s, rec := New(), httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Handler().ServeHTTP(rec, req)
	}()
	defer func() { cancel(); <-done }()
	var seq int64
	waiting := false
	for !waiting && ctx.Err() == nil {
		st := s.Trace(ctx, seq, time.Second)
		seq = st.Seq
		for _, route := range st.Routes {
			for _, attempt := range route.Tries {
				waiting = waiting || attempt.Again > int64(time.Hour/time.Millisecond)
			}
		}
	}
	if !waiting {
		t.Fatal("request never entered its long quota wait")
	}
	recovered.Store(true)
	provider.StaleAllowance("codex", "me@example.com")
	if !provider.AwaitAllowance(ctx, "codex", "me@example.com") {
		t.Fatal("recovered allowance was not read")
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("allowance recovered but the original request kept waiting for the old reset")
	}
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "pong") {
		t.Fatalf("early recovery did not resume the request: %d %s", rec.Code, rec.Body.String())
	}
}

// An authorized reset card is tried before entering the potentially long wait.
func TestCodexQuotaResumeSpendsAuthorizedResetBeforeWaiting(t *testing.T) {
	codexSignedIn(t, "spare@example.com")
	backend := newResetBackend(t, "acct-1", "acct-2")
	codexQuotaResumeMax = 3 * time.Second
	if err := provider.SetCodexAutoReset("me@example.com", true); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(`{"model":"gpt-5.5","stream":true,"input":"ping"}`)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer chatgpt-token")
	req.Header.Set("chatgpt-account-id", "acct-1")
	// Use a maximum long enough to expose the old wait-before-reset ordering.
	codexQuotaResumeMax = 3 * time.Hour
	New().Handler().ServeHTTP(rec, req)
	tried, spent := backend.seen()
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "pong") || spent != "acct-1" {
		t.Fatalf("authorized reset was blocked by quota wait: status=%d tried=%s spent=%s body=%s", rec.Code, tried, spent, rec.Body.String())
	}
}
