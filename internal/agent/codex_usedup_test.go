package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A quota result never changes Codex's sign-in mode. An official ChatGPT
// sign-in remains beside magpie, while magpie API is an explicit choice.
func TestCodexRunsOutAfterPick(t *testing.T) {
	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`, "")
	cx := codex(home)
	if err := cx.Fields[0].Set("fake/m1"); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); strings.Contains(cfg, "model_provider =") || !strings.Contains(cfg, "openai_base_url") {
		t.Fatalf("beside the sign-in:\n%s", cfg)
	}
	codexUsedUp = func() bool { return true }
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); strings.Contains(cfg, `model_provider = "magpie"`) || strings.Contains(cfg, "model_catalog_json") ||
		!strings.Contains(cfg, "openai_base_url") || !strings.Contains(cfg, `model = "fake/m1"`) {
		t.Fatalf("quota changed the sign-in mode:\n%s", cfg)
	}
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); strings.Contains(cfg, `model_provider = "magpie"`) {
		t.Fatalf("quota changed the sign-in mode on the next sync:\n%s", cfg)
	}
	codexUsedUp = func() bool { return false }
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); strings.Contains(cfg, "model_provider =") || strings.Contains(cfg, "model_catalog_json") ||
		!strings.Contains(cfg, "openai_base_url") || !strings.Contains(cfg, `model = "fake/m1"`) {
		t.Fatalf("allowance recovery changed the sign-in mode:\n%s", cfg)
	}

	// magpie as the provider because the user asked for it stays so
	if err := cx.Field("login").Set("api"); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); !strings.Contains(cfg, `model_provider = "magpie"`) {
		t.Fatalf("api:\n%s", cfg)
	}
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); !strings.Contains(cfg, `model_provider = "magpie"`) {
		t.Fatalf("api, allowance there, synced:\n%s", cfg)
	}
}

// The explicit Always ChatGPT choice remains stable across Sync as well.
func TestCodexKeptOnChatGPT(t *testing.T) {
	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`, "")
	cx := codex(home)
	if err := cx.Fields[0].Set("fake/m1"); err != nil {
		t.Fatal(err)
	}
	codexUsedUp = func() bool { return true }
	t.Cleanup(func() { codexUsedUp = func() bool { return false } })
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); strings.Contains(cfg, `model_provider = "magpie"`) {
		t.Fatalf("ChatGPT, used up: magpie became its provider:\n%s", cfg)
	}

	beside := func(when string) {
		t.Helper()
		if cfg := read(); strings.Contains(cfg, "model_provider =") || strings.Contains(cfg, "model_catalog_json") ||
			!strings.Contains(cfg, "openai_base_url") || !strings.Contains(cfg, `model = "fake/m1"`) {
			t.Fatalf("%s:\n%s", when, cfg)
		}
	}
	if err := cx.Field("login").Set("chatgpt"); err != nil {
		t.Fatal(err)
	}
	beside("kept on ChatGPT, used up")
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	beside("kept on ChatGPT, used up, synced")
	if err := cx.Fields[0].Set("fake/m1"); err != nil {
		t.Fatal(err)
	}
	beside("kept on ChatGPT, used up, picked")
	if got := cx.Field("login").Get(); got != "chatgpt" {
		t.Fatalf("login %q", got)
	}

	// Switching back to the default ChatGPT mode keeps it beside magpie too.
	if err := cx.Field("login").Set(""); err != nil {
		t.Fatal(err)
	}
	beside("ChatGPT again, used up")
}

// An own model remains joined beside the official sign-in across quota changes.
func TestCodexOwnModelRemainsJoinedWhileUsedUp(t *testing.T) {
	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`, "model = \"gpt-a\"\n")
	os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"),
		[]byte(`{"models":[{"slug":"gpt-a","display_name":"A","priority":1}]}`), 0o644)
	cx := codex(home)
	if ok, err := cx.Join(); err != nil || !ok {
		t.Fatalf("join: %v %v", ok, err)
	}
	for _, used := range []bool{true, true, false} {
		codexUsedUp = func() bool { return used }
		if err := cx.Sync(); err != nil {
			t.Fatal(err)
		}
		if cfg := read(); strings.Contains(cfg, "model_provider =") || !strings.Contains(cfg, `model = "gpt-a"`) {
			t.Fatalf("quota changed own model or sign-in:\n%s", cfg)
		}
		if cx.AppOut() || !cx.Joined() {
			t.Fatalf("used=%v: AppOut=%v Joined=%v", used, cx.AppOut(), cx.Joined())
		}
	}
}

// Kept on ChatGPT, a used-up account on one of Codex's own models leaves
// Codex as it is: the user chose the sign-in.
func TestCodexOwnModelKeptOnChatGPT(t *testing.T) {
	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`, "model = \"gpt-a\"\n")
	os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"),
		[]byte(`{"models":[{"slug":"gpt-a","display_name":"A","priority":1}]}`), 0o644)
	cx := codex(home)
	if ok, err := cx.Join(); err != nil || !ok {
		t.Fatalf("join: %v %v", ok, err)
	}
	if err := cx.Field("login").Set("chatgpt"); err != nil {
		t.Fatal(err)
	}
	codexUsedUp = func() bool { return true }
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	if cfg := read(); strings.Contains(cfg, "model_provider =") || !strings.Contains(cfg, `model = "gpt-a"`) {
		t.Fatalf("kept on ChatGPT, used up:\n%s", cfg)
	}
	if cx.AppOut() {
		t.Fatal("kept on ChatGPT: AppOut")
	}
}

// Choosing Always ChatGPT while quota is exhausted keeps the joined model
// and official sign-in through subsequent Sync calls and quota recovery.
func TestCodexOwnModelAlwaysChatGPTKeepsSignIn(t *testing.T) {
	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`, "model = \"gpt-a\"\n")
	os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"),
		[]byte(`{"models":[{"slug":"gpt-a","display_name":"A","priority":1}]}`), 0o644)
	cx := codex(home)
	if ok, err := cx.Join(); err != nil || !ok {
		t.Fatalf("join: %v %v", ok, err)
	}
	codexUsedUp = func() bool { return true }
	t.Cleanup(func() { codexUsedUp = func() bool { return false } })
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	if cx.AppOut() {
		t.Fatalf("quota changed official sign-in:\n%s", read())
	}
	if err := cx.Field("login").Set("chatgpt"); err != nil {
		t.Fatal(err)
	}
	onSignIn := func(when string) {
		t.Helper()
		if cfg := read(); strings.Contains(cfg, "model_provider =") || strings.Contains(cfg, "model_catalog_json") || !strings.Contains(cfg, `model = "gpt-a"`) {
			t.Fatalf("%s:\n%s", when, cfg)
		}
		if cx.AppOut() {
			t.Fatalf("%s: AppOut", when)
		}
	}
	onSignIn("kept on ChatGPT while used up")
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	onSignIn("kept on ChatGPT, synced")
	codexUsedUp = func() bool { return false }
	if err := cx.Sync(); err != nil {
		t.Fatal(err)
	}
	onSignIn("kept on ChatGPT, allowance back")
}
