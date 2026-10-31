package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// next is a selector, including when there is no account to select.
// It must not be resolved as the literal saved-account name "next".
func TestAccountsNextIsSelector(t *testing.T) {
	home := t.TempDir()
	for _, key := range []string{"HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR"} {
		t.Setenv(key, filepath.Join(home, key))
	}
	p := filepath.Join(filepath.Dir(provider.Path()), "logins.json")
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	provider.ForgetAccounts()
	t.Cleanup(provider.ForgetAccounts)
	_, err := said(t, func() error { return accountsCmd([]string{"accounts", "switch", "claude", "next"}) })
	if err == nil || !strings.Contains(err.Error(), "no other account") {
		t.Fatalf("next was not treated as an account selector: %v", err)
	}
}
