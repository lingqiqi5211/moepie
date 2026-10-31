package datamove

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The fixture is a separate executable process, so assigning it to a job
// never changes the test runner or other tests' process trees.
func TestBrowserWriterJob(t *testing.T) {
	if os.Getenv("MAGPIE_WRITER_FIXTURE") != "" {
		t.Skip("fixture child")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestBrowserWriterFixture$", "-test.v")
	cmd.Env = append(os.Environ(), "MAGPIE_WRITER_FIXTURE=helper", "MAGPIE_WRITER_DIR="+t.TempDir())
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("native writer fixture: %v\n%s", err, b)
	}
}

func waitWriterFile(t *testing.T, name string) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); ; {
		if _, err := os.Stat(name); err == nil {
			return
		}
		if time.Now().After(end) {
			t.Fatalf("writer did not signal %s", name)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestBrowserWriterFixture(t *testing.T) {
	mode := os.Getenv("MAGPIE_WRITER_FIXTURE")
	if mode == "" {
		t.Skip("only invoked by writer job regression")
	}
	dir := os.Getenv("MAGPIE_WRITER_DIR")
	command := func(mode string) *exec.Cmd {
		c := exec.Command(os.Args[0], "-test.run=^TestBrowserWriterFixture$")
		// Avoid duplicate environment keys (Windows lookup uses the first).
		c.Env = []string{"SystemRoot=" + os.Getenv("SystemRoot"), "WINDIR=" + os.Getenv("WINDIR"), "TEMP=" + dir, "TMP=" + dir, "MAGPIE_WRITER_FIXTURE=" + mode, "MAGPIE_WRITER_DIR=" + dir}
		return c
	}
	switch mode {
	case "owner":
		waitWriterFile(t, filepath.Join(dir, "owner-release"))
		return
	case "parent":
		// A short-lived browser parent starts a writer and exits without waiting.
		if err := command("writer").Start(); err != nil {
			t.Fatal(err)
		}
		return
	case "writer":
		// Releasing lockfile says nothing about this grandchild's remaining writes.
		if err := os.WriteFile(filepath.Join(dir, "lockfile"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(dir, "lockfile")); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "ready"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		waitWriterFile(t, filepath.Join(dir, "release"))
		if err := os.WriteFile(filepath.Join(dir, "CrashpadMetrics-active.pma"), []byte("late writer flushed"), 0600); err != nil {
			t.Fatal(err)
		}
		return
	case "probe":
		// The replacement GUI must escape the finished job, without nesting it.
		TrackBrowserWriters()
		if browserTracking.err != nil {
			t.Fatal(browserTracking.err)
		}
		if err := os.WriteFile(filepath.Join(dir, "probe-ready"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		waitWriterFile(t, filepath.Join(dir, "probe-release"))
		return
	case "helper":
		TrackBrowserWriters()
		if browserTracking.err != nil {
			t.Fatal(browserTracking.err)
		}
		job := browserTracking.job
		if err := inBrowserJob(windows.CurrentProcess(), job); err != nil {
			t.Fatal(err)
		}
		owner := command("owner")
		if err := owner.Start(); err != nil {
			t.Fatal(err)
		}
		defer os.WriteFile(filepath.Join(dir, "owner-release"), nil, 0600)
		howner, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(owner.Process.Pid))
		if err != nil {
			t.Fatal(err)
		}
		created, err := processCreated(howner)
		windows.CloseHandle(howner)
		if err != nil {
			t.Fatal(err)
		}
		proof := *browserTracking.proof
		proof.PID = uint32(owner.Process.Pid)
		proof.Created = created + 1
		if _, _, err := browserBarrier(&Transaction{Browser: &proof}); err == nil {
			t.Fatal("reused PID identity accepted")
		}
		proof.Created = created
		if _, closeJob, err := browserBarrier(&Transaction{Browser: &proof}); err != nil {
			t.Fatal(err)
		} else {
			closeJob()
		}
		if err := os.WriteFile(filepath.Join(dir, "owner-release"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if err := owner.Wait(); err != nil {
			t.Fatal(err)
		}
		defer os.WriteFile(filepath.Join(dir, "release"), nil, 0600)
		parent := command("parent")
		if err := parent.Run(); err != nil {
			t.Fatal(err)
		}
		waitWriterFile(t, filepath.Join(dir, "ready"))
		if _, err := os.Stat(filepath.Join(dir, "lockfile")); !os.IsNotExist(err) {
			t.Fatalf("browser lock still exists: %v", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
		err = waitBrowserJob(ctx, job, time.Second)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("copied with late grandchild alive: %v", err)
		}
		ctx, cancel = context.WithCancel(context.Background())
		cancel()
		if err := waitBrowserJob(ctx, job, time.Second); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
		if _, err := browserActive(windows.InvalidHandle); err == nil {
			t.Fatal("query failure was accepted")
		}
		if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if err := waitBrowserJob(context.Background(), job, 10*time.Second); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(dir, "CrashpadMetrics-active.pma"))
		if err != nil || string(b) != "late writer flushed" {
			t.Fatalf("copy preceded final flush: %q %v", b, err)
		}
		// Starting the replacement outside the old job is essential for repeated moves.
		probe := command("probe")
		if err := probe.Start(); err != nil {
			t.Fatal(err)
		}
		defer os.WriteFile(filepath.Join(dir, "probe-release"), nil, 0600)
		waitWriterFile(t, filepath.Join(dir, "probe-ready"))
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(probe.Process.Pid))
		if err != nil {
			t.Fatal(err)
		}
		err = inBrowserJob(h, job)
		windows.CloseHandle(h)
		if !errors.Is(err, errOutsideBrowserJob) {
			t.Fatalf("replacement did not escape completed job: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "probe-release"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if err := probe.Wait(); err != nil {
			t.Fatal(err)
		}
		proof = *browserTracking.proof
		proof.Created++
		// PID==self must never be accepted as a purported preceding GUI.
		if _, _, err := browserBarrier(&Transaction{Browser: &proof}); err == nil {
			t.Fatal("helper accepted self as GUI owner")
		}
	default:
		t.Fatalf("unexpected fixture mode %q", mode)
	}
}
