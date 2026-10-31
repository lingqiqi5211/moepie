package usage

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/sessions"
)

func forgetEffortForRestart() {
	codexEffort.Lock()
	clear(codexEffort.periods)
	codexEffort.Unlock()
	// A different process assigns its own snapshot versions.
	logIndex.Lock()
	logIndex.snapshot = nil
	logIndex.version += 100
	logIndex.Unlock()
}

func TestCodexEffortDiskKeepsPeriodsAcrossRestart(t *testing.T) {
	effortFixture(t)
	built := 0
	effortBuilt = func() { built++ }
	t.Cleanup(func() { effortBuilt = nil })
	want := map[Period]map[string][]sessions.ModelEffort{}
	for _, p := range []Period{All, Month} {
		want[p] = CodexModelEffort(p)
		if len(want[p]["main-a"]) != 1 {
			t.Fatalf("fixture: %s = %+v", p, want[p])
		}
	}
	if built != 2 {
		t.Fatalf("cold build count = %d, want 2", built)
	}
	for range 2 {
		forgetEffortForRestart()
		for _, p := range []Period{All, Month} {
			if got := CodexModelEffort(p); !reflect.DeepEqual(got, want[p]) {
				t.Fatalf("warm %s = %+v, want %+v", p, got, want[p])
			}
		}
	}
	if built != 2 {
		t.Fatalf("warm All/30d rebuilt the ledger: %d builds, want 2", built)
	}
}

func TestCodexEffortDiskInvalidatesInputsAndDay(t *testing.T) {
	now, rollout := effortFixture(t)
	built := 0
	effortBuilt = func() { built++ }
	t.Cleanup(func() { effortBuilt = nil })
	CodexModelEffort(All)
	writeCodexCall(t, rollout, "main-a", "main-a", `"vscode"`, "resp-1", "m", "high", now.Add(-time.Hour), 2000, 30)
	later := now.Add(time.Minute)
	if err := os.Chtimes(rollout, later, later); err != nil {
		t.Fatal(err)
	}
	forgetEffortForRestart()
	if got, ok := findModelEffort(CodexModelEffort(All)["main-a"], "m", "high"); !ok || got.Input != 2000 || built != 2 {
		t.Fatalf("changed rollout reused stale effort: built %d, %+v", built, got)
	}
	Append(Record{Time: now, Agent: "pi", Model: "m", Input: 1, Status: 200})
	forgetEffortForRestart()
	CodexModelEffort(All)
	if built != 3 {
		t.Fatalf("changed log: builds %d, want 3", built)
	}
	Clock = func() time.Time { return now.AddDate(0, 0, 1) }
	forgetEffortForRestart()
	CodexModelEffort(All)
	if built != 4 {
		t.Fatalf("next local day reused old answer: builds %d, want 4", built)
	}
	// Same files under a different ledger root may never reuse an answer.
	st := readRequestState(Clock())
	key := effortDiskKey(st, Month, Clock())
	st.root = filepath.Join(t.TempDir(), "usage.jsonl") + "|" + filepath.Join(t.TempDir(), "catalog.json")
	if got := effortDiskKey(st, Month, Clock()); got == key {
		t.Fatal("another root has the same effort key")
	}
}

func TestCodexEffortDiskBadFilesRebuild(t *testing.T) {
	for _, bad := range []string{`{"Version":`, `{"Version":99,"Entries":[]}`, `{"Version":1,"Entries":[{"Key":"wrong","Value":{}}]}`} {
		t.Run(bad, func(t *testing.T) {
			effortFixture(t)
			CodexModelEffort(All)
			if err := os.WriteFile(effortDiskPath(), []byte(bad), 0o600); err != nil {
				t.Fatal(err)
			}
			forgetEffortForRestart()
			built := 0
			effortBuilt = func() { built++ }
			t.Cleanup(func() { effortBuilt = nil })
			if got := CodexModelEffort(All); len(got["main-a"]) != 1 || built != 1 {
				t.Fatalf("bad file became an answer: builds %d, %+v", built, got)
			}
		})
	}
}

func TestCodexEffortDiskBoundedAndPrivate(t *testing.T) {
	effortFixture(t)
	periods := []Period{All, Month, Week, Today, "2026-09-01..2026-09-30"}
	for _, p := range periods {
		CodexModelEffort(p)
	}
	entries := readEffortDisk()
	if len(entries) != effortDiskPeriods || entries[0].Period != periods[4] {
		t.Fatalf("kept periods = %+v, want newest four", entries)
	}
	for _, e := range entries {
		if e.Period == All {
			t.Fatal("oldest period was not evicted")
		}
	}
	info, err := os.Stat(effortDiskPath())
	if err != nil {
		t.Fatal(err)
	}
	// Windows reports writable files as 0666; Mode does not expose ACLs.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("effort cache mode = %o, want private", info.Mode().Perm())
	}
	// An unwritable cache location is only a miss, with the ledger usable.
	if err := os.Remove(effortDiskPath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(effortDiskPath(), 0o700); err != nil {
		t.Fatal(err)
	}
	forgetEffortForRestart()
	if got := CodexModelEffort(All); len(got["main-a"]) != 1 {
		t.Fatalf("failed disk read/write lost the answer: %+v", got)
	}
}
