package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/catalog"
)

// #1907 (foobra): Codex Desktop and the CLI on their own ChatGPT
// subscription, two accounts, no gateway in between. Switch-only is kept on
// Codex's subscription; with it on, the account Codex is signed in to
// running out still signs Codex in to the next one with room, in its own
// auth.json, and back once the first has room again. A providers.json
// that can't be read
// says switch-only: the user's choice is unknown, and failover through the
// gateway, magpie's own idea, isn't taken up on it.
func TestCodexSwitchOnlyStillSwitchesTheSignIn(t *testing.T) {
	home := signIn(t) // me@example.com, acct-1
	rememberLogins(true)
	codexSignIn(t, home, "spare@example.com", "r-spare")
	rememberLogins(true)
	codexSignIn(t, home, "me@example.com", "r-1")
	rememberLogins(true)
	used := map[string]float64{"acct-me@example.com": 100, "acct-spare@example.com": 20}
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"plan_type": "plus", "rate_limit": map[string]any{
			"primary_window": map[string]any{"used_percent": used[r.Header.Get("chatgpt-account-id")], "limit_window_seconds": 18000}}})
	}))
	defer fake.Close()
	old := CodexBase
	CodexBase = fake.URL + "/backend-api/codex"
	t.Cleanup(func() { CodexBase = old })
	switched := func() string {
		t.Helper()
		loginUsageCache.Lock()
		loginUsageCache.m = nil
		loginUsageCache.Unlock()
		to, err := SwitchWhenSpent(context.Background(), "codex")
		if err != nil {
			t.Fatal(err)
		}
		return to
	}
	signedIn := func() string {
		t.Helper()
		var live codexAuth
		readJSON(filepath.Join(home, ".codex", "auth.json"), &live)
		return live.Tokens.RefreshToken
	}
	if err := SetLoginOn("codex", "spare@example.com", true); err != nil {
		t.Fatal(err)
	}

	if SwitchOnly("codex") {
		t.Fatal("switch-only before the user set it")
	}
	if err := SetSwitchOnly("codex", true); err != nil {
		t.Fatal(err)
	}
	if !SwitchOnly("codex") {
		t.Fatal("switch-only not kept")
	}
	p, err := Find("codex")
	if err != nil || !p.SwitchOnly {
		t.Fatalf("Find: %+v %v", p, err)
	}
	// out: on to the spare, in Codex's own auth.json
	if to := switched(); to != "spare@example.com" || signedIn() != "r-spare" {
		t.Fatalf("switched to %q, Codex signed in with %q", to, signedIn())
	}
	// the first has room again: back to it
	used["acct-me@example.com"] = 10
	if to := switched(); !strings.HasPrefix(to, "me@example.com") || signedIn() != "r-1" {
		t.Fatalf("back to %q, Codex signed in with %q", to, signedIn())
	}
	if !SwitchOnly("codex") {
		t.Fatal("switch-only lost on a switch")
	}

	if err := SetSwitchOnly("codex", false); err != nil || SwitchOnly("codex") {
		t.Fatalf("off: %v, still %v", err, SwitchOnly("codex"))
	}
	// neither the file nor its last good generation reads
	for _, f := range []string{Path(), Path() + ".bak"} {
		if err := os.WriteFile(f, []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if !SwitchOnly("codex") {
		t.Error("an unreadable providers.json read as switch-only off")
	}
}

// myduso on Discord: Claude's subscription kept to Claude Code alone.
// magpie still signs Claude Code in to the next account with room, by
// writing Claude Code's own sign-in, and serves nothing on the accounts:
// they leave the catalog, a request naming them is refused as switched
// off, and none of it is the raw Off a user's switch writes.
func TestClaudeSwitchOnlyServesNothingAndStillSwitches(t *testing.T) {
	home := claudeHome(t)
	cred := claudeSignIn(t, home, time.Now().Add(time.Hour)) // sk-ant-oat01-old
	writeFile(t, filepath.Join(home, ".claude.json"), map[string]any{"oauthAccount": map[string]any{"emailAddress": "a@example.com", "accountUuid": "u-a"}})
	rememberLogins(true)
	loginsMu.Lock()
	ls := upsertLogin(readLogins(), savedLogin{Agent: "claude", User: "b@example.com", Plan: "max", On: true, Seen: time.Now().UTC(),
		Auth: mustJSONRaw(t, map[string]any{"claudeAiOauth": map[string]any{"accessToken": "sk-ant-oat01-b", "refreshToken": "sk-ant-ort01-b",
			"expiresAt": time.Now().Add(time.Hour).UnixMilli(), "subscriptionType": "max", "scopes": []string{"user:inference", "user:profile"}}}),
		Profile: mustJSONRaw(t, map[string]any{"emailAddress": "b@example.com", "accountUuid": "u-b"})})
	if err := writeLogins(ls); err != nil {
		t.Fatal(err)
	}
	loginsMu.Unlock()
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("usage endpoint read: %s", r.URL)
	}))
	defer fake.Close()
	claudeBase = fake.URL // isolate puts it back
	os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755)
	if err := os.WriteFile(catalog.CachePath(), []byte(`{"anthropic": {"models": {
	  "claude-sonnet-5": {"id":"claude-sonnet-5","name":"Claude Sonnet 5","modalities":{"input":["text"],"output":["text"]}}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	catalog.Reset()
	t.Cleanup(catalog.Reset)
	if p, err := Find("claude"); err != nil {
		t.Fatal(err)
	} else if _, err := p.Fetch(context.Background()); err != nil {
		t.Fatal(err)
	}

	served := func() bool {
		t.Helper()
		for _, e := range Catalog() {
			if e.Provider.ID == "claude" {
				return true
			}
		}
		return false
	}
	p, err := Find("claude")
	if err != nil || !p.On() || p.KeptToAgent() || !served() {
		t.Fatalf("before: %+v %v, served %v", p, err, served())
	}
	if err := SetSwitchOnly("claude", true); err != nil {
		t.Fatal(err)
	}
	p, err = Find("claude")
	if err != nil || !p.SwitchOnly || !p.KeptToAgent() || p.On() || p.Off {
		t.Fatalf("kept to Claude Code: %+v %v", p, err)
	}
	if served() {
		t.Error("the catalog still serves the Claude accounts")
	}
	if _, _, ok := Resolve("claude/claude-sonnet-5"); ok {
		t.Error("claude/claude-sonnet-5 resolves kept to Claude Code")
	}
	if _, off := SwitchedOff("claude/claude-sonnet-5"); !off {
		t.Error("a request naming the Claude accounts isn't refused as switched off")
	}
	if leftAlone("claude") {
		t.Fatal("kept to Claude Code reads as left alone: no switching, no usage")
	}

	// spent: Claude Code's own sign-in goes on to b
	for user, u := range map[string]float64{"a@example.com": 99, "b@example.com": 10} {
		NoteClaudeLimits(user, []ClaudeLimit{{Kind: "five_hour", Used: u / 100, ResetsAt: time.Now().Add(time.Hour).Unix()}})
	}
	to, err := SwitchWhenSpent(context.Background(), "claude")
	if err != nil || to != "b@example.com" {
		t.Fatalf("switched to %q: %v", to, err)
	}
	var c map[string]any
	readJSON(cred, &c)
	if o, _ := c["claudeAiOauth"].(map[string]any); o["refreshToken"] != "sk-ant-ort01-b" {
		t.Fatalf("Claude Code is signed in with %v", o)
	}
	if p, _ := Find("claude"); !p.KeptToAgent() {
		t.Fatal("kept to Claude Code lost on a switch")
	}

	if err := SetSwitchOnly("claude", false); err != nil {
		t.Fatal(err)
	}
	if p, _ := Find("claude"); !p.On() || !served() {
		t.Fatalf("off again: %+v, served %v", p, served())
	}
	if _, off := SwitchedOff("claude/claude-sonnet-5"); off {
		t.Error("still refused as switched off")
	}
	if _, _, ok := Resolve("claude/claude-sonnet-5"); !ok {
		t.Error("claude/claude-sonnet-5 doesn't resolve unticked")
	}
}
