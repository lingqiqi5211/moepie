package provider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCswapMalformedKeepsExisting(t *testing.T) {
	claudeHome(t)
	b, err := os.ReadFile("testdata/cswap_0.29.0_export.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ImportLogins(context.Background(), "claude", []string{string(b)}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(loginsPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{`, `{"version":1,"encrypted":false,"accounts":"broken"}`, `{"version":1,"encrypted":false,"accounts":[42]}`} {
		rows, err := ImportLogins(context.Background(), "claude", []string{bad})
		if err == nil {
			for _, row := range rows {
				if row.Status == "added" || row.Status == "updated" {
					t.Fatalf("malformed imported: %+v", rows)
				}
			}
		}
		after, e := os.ReadFile(loginsPath())
		if e != nil || string(after) != string(before) {
			t.Fatalf("malformed changed existing: %v %v", err, e)
		}
	}
}

func TestNextFailedRefreshDoesNotUseKeptDisplayQuota(t *testing.T) {
	u := threeAccounts(t, "codex")
	LoginUsageVia(nil)
	loginUsageCache.Lock()
	loginUsageCache.m = map[string]loginUsageEntry{}
	for _, user := range u {
		q := SubscriptionQuota{Provider: "codex", Windows: []QuotaWindow{{Name: "5 hours", Used: 10}}}
		loginUsageCache.m["codex/"+user] = loginUsageEntry{at: time.Now(), q: q, read: SubscriptionQuota{Error: "refresh failed"}}
	}
	loginUsageCache.Unlock()
	t.Cleanup(func() { loginUsageCache.Lock(); loginUsageCache.m = nil; loginUsageCache.Unlock() })
	if to, _, err := NextInOrder(context.Background(), "codex"); err == nil || to != "" {
		t.Fatalf("kept display quota used after failed refresh: %q %v", to, err)
	}
}

func TestAutoStaleSpentNeedsFreshSpare(t *testing.T) {
	past, future := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	for _, tc := range []struct {
		name         string
		currentReset time.Time
		spare        SubscriptionQuota
	}{
		{"stale spare", future, SubscriptionQuota{AsOf: &past, Windows: []QuotaWindow{{Name: "5 hours", Used: 10, ResetsAt: &future}}}},
		{"error spare", future, SubscriptionQuota{Error: "failed"}},
		{"unknown spare", future, SubscriptionQuota{}},
		{"spent spare", future, SubscriptionQuota{Windows: []QuotaWindow{{Name: "5 hours", Used: 100, ResetsAt: &future}}}},
		{"reset current", past, SubscriptionQuota{Windows: []QuotaWindow{{Name: "5 hours", Used: 10, ResetsAt: &future}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := threeAccounts(t, "claude")
			LoginUsageVia(func(context.Context, string) map[string]SubscriptionQuota {
				return map[string]SubscriptionQuota{
					u[2]: {AsOf: &past, Windows: []QuotaWindow{{Name: "5 hours", Used: 100, ResetsAt: &tc.currentReset}}}, u[0]: tc.spare, u[1]: tc.spare,
				}
			})
			t.Cleanup(func() { LoginUsageVia(nil) })
			if from, to, _, ok := NextLogin(context.Background(), "claude"); ok {
				t.Fatalf("unexpected switch %q -> %q", from, to)
			}
		})
	}
}

func TestForgetFailedSwitchKeepsCurrent(t *testing.T) {
	home := signIn(t)
	rememberLogins(true)
	codexSignIn(t, home, "spare@example.com", "r-spare")
	rememberLogins(true)
	live, ok := liveLogin("codex")
	if !ok {
		t.Fatal("no live account")
	}
	before, err := os.ReadFile(loginsPath())
	if err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(home, ".codex", "config.toml")
	if err := os.WriteFile(cfg, []byte("[broken"), 0600); err != nil {
		t.Fatal(err)
	}
	err = ForgetLogin("codex", live.User)
	if err == nil || !strings.Contains(err.Error(), "is kept") {
		t.Fatalf("failed switch: %v", err)
	}
	after, e := os.ReadFile(loginsPath())
	if e != nil || string(after) != string(before) {
		t.Fatalf("failed switch changed records: %v", e)
	}
	now, ok := liveLogin("codex")
	if !ok || now.User != live.User {
		t.Fatalf("current changed: %+v", now)
	}
}
