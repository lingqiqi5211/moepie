package provider

import (
	"context"
	"testing"
	"time"
)

func TestAllowanceCardRefreshWakesAndInvalidatesRouting(t *testing.T) {
	isolate(t)
	startWithNoAllowancesRead(t)
	used := 100.0
	reads := 0
	LoginUsageVia(func(context.Context, string) map[string]SubscriptionQuota {
		reads++
		reset := time.Now().Add(time.Hour)
		return map[string]SubscriptionQuota{"user": {Windows: []QuotaWindow{
			{Name: "5 hours", Used: used, ResetsAt: &reset, Span: 5 * time.Hour},
		}}}
	})
	t.Cleanup(func() { LoginUsageVia(nil) })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if !AwaitAllowance(ctx, "codex", "user") || reads != 1 {
		t.Fatal("initial allowance was not read")
	}
	first, second := AllowanceChanges(), AllowanceChanges()
	used = 0
	toldUsage() // same notification as a quota card's Refresh button
	for _, ch := range []<-chan struct{}{first, second} {
		select {
		case <-ch:
		default:
			t.Fatal("card refresh did not wake a request waiting for its old reset")
		}
	}
	landed := AllowanceChanges()
	if !AwaitAllowance(ctx, "codex", "user") {
		t.Fatal("refreshed allowance was not read")
	}
	if got := Allowances("codex")["user"]; len(got) != 1 || got[0].Used != 0 || reads != 2 {
		t.Fatalf("routing kept stale allowance after card refresh: reads=%d allowance=%+v", reads, got)
	}
	select {
	case <-landed:
	case <-ctx.Done():
		t.Fatal("the completed routing refresh did not wake waiters")
	}
}
