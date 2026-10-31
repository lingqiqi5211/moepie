package davsync

import (
	"context"
	"testing"

	"github.com/yetone/magpie/internal/backup"
)

func TestOwnUploadKeepsLocalFieldsPrivate(t *testing.T) {
	f, c, _ := ownBoundaryFixture(t)
	codexPick(t, "gpt-private", "low")
	const at = "/dav/magpie/magpie.magpie-backup"
	f.mu.Lock()
	delete(f.files, at)
	f.mu.Unlock()
	if err := Upload(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	data := append([]byte(nil), f.files[at]...)
	f.mu.Unlock()
	b, err := backup.Open(data, c.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := b.Agents["codex.model"]; ok {
		t.Fatalf("own model uploaded during recovery: %q", v)
	}
	if m, _ := codexHere(); m != "gpt-private" {
		t.Fatalf("local model changed: %q", m)
	}
	if !loadState().Own["codex.model"] {
		t.Fatal("upload cleared ownership")
	}
}
