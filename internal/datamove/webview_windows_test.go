package datamove

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// A WebView2 browser holds EBWebView\lockfile open without sharing delete
// while it runs: the move waits for it, and gives up if it doesn't go.
func TestWebViewGoneWaitsForTheBrowser(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "EBWebView", "lockfile")
	write(t, lock, "")
	p, _ := syscall.UTF16PtrFromString(lock)
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := webViewGone(context.Background(), dir, 200*time.Millisecond); err == nil {
		windows.CloseHandle(h)
		t.Fatal("a running browser's profile passed")
	}
	go func() { time.Sleep(200 * time.Millisecond); windows.CloseHandle(h) }()
	if err := webViewGone(context.Background(), dir, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lock); !os.IsNotExist(err) {
		t.Fatal("the lockfile is still there")
	}
	if err := webViewGone(context.Background(), t.TempDir(), time.Second); err != nil {
		t.Fatalf("a profile with no lockfile: %v", err)
	}
}
