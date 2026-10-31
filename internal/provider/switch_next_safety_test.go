package provider

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestNextRejectsUncertainReadings(t *testing.T) {
	for _, agent := range []string{"codex", "claude"} {
		t.Run(agent, func(t *testing.T) {
			u := threeAccounts(t, agent)
			t.Cleanup(func() { LoginUsageVia(nil) })
			for _, which := range []string{"unknown", "error", "stale", "empty", "held", "partial"} {
				t.Run(which, func(t *testing.T) {
					LoginUsageVia(func(ctx context.Context, _ string) map[string]SubscriptionQuota {
						qs := usedAt(agent, map[string]float64{u[0]: 10, u[1]: 20, u[2]: 100})(ctx, agent)
						for _, user := range u[:2] {
							q := qs[user]
							switch which {
							case "unknown":
								delete(qs, user)
								continue
							case "error", "partial":
								q.Error = "reading failed"
							case "stale":
								at := time.Now().Add(-time.Hour)
								q.AsOf = &at
							case "empty":
								q.Windows = nil
							case "held":
								q.Held = true
							}
							qs[user] = q
						}
						if which == "partial" {
							qs[u[1]] = usedAt(agent, map[string]float64{u[1]: 20})(ctx, agent)[u[1]]
						}
						return qs
					})
					to, _, err := NextInOrder(context.Background(), agent)
					if which == "partial" {
						if err != nil || to != u[1] {
							t.Fatalf("partial: %q %v", to, err)
						}
						return
					}
					if err == nil || to != "" {
						t.Fatalf("uncertain reading chose %q: %v", to, err)
					}
					if _, _, _, ok := NextLogin(context.Background(), agent); ok {
						t.Fatal("automatic switch took an uncertain reading")
					}
				})
			}
			for _, kind := range []string{"unknown", "error", "stale"} {
				t.Run("most current "+kind, func(t *testing.T) {
					LoginUsageVia(func(ctx context.Context, _ string) map[string]SubscriptionQuota {
						qs := usedAt(agent, map[string]float64{u[0]: 99, u[1]: 100, u[2]: 100})(ctx, agent)
						q := qs[u[2]]
						switch kind {
						case "unknown":
							delete(qs, u[2])
							return qs
						case "error":
							q.Error = "failed"
						case "stale":
							at := time.Now().Add(-time.Hour)
							q.AsOf = &at
						}
						qs[u[2]] = q
						return qs
					})
					if _, _, _, ok := NextLogin(context.Background(), agent); ok {
						t.Fatal("most compared uncertain current account")
					}
				})
			}
			canceled, cancel := context.WithCancel(context.Background())
			cancel()
			LoginUsageVia(func(context.Context, string) map[string]SubscriptionQuota {
				t.Fatal("canceled selection read usage")
				return nil
			})
			if to, _, err := NextInOrder(canceled, agent); !errors.Is(err, context.Canceled) || to != "" {
				t.Fatalf("canceled: %q %v", to, err)
			}
		})
	}
}

func TestNextUnreadCredentialsPreserved(t *testing.T) {
	home := signIn(t)
	rememberLogins(true)
	p := loginsPath()
	bad := []byte(`{"broken":`)
	if err := os.WriteFile(p, bad, 0600); err != nil {
		t.Fatal(err)
	}
	if to, _, err := NextInOrder(context.Background(), "codex"); err == nil || to != "" {
		t.Fatalf("unread logins: %q %v", to, err)
	}
	b, err := os.ReadFile(p)
	if err != nil || string(b) != string(bad) {
		t.Fatalf("credentials changed: %s %v", b, err)
	}
	_ = home
}
