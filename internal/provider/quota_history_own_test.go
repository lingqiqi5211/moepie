package provider

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/testenv"
)

// countReads stands in for readQuotaHist so a test can tell how many times
// the history file was read, and gives the count.
func countReads(t *testing.T) *int {
	t.Helper()
	n := 0
	old := readQuotaHist
	readQuotaHist = func() quotaHist {
		n++
		return old()
	}
	t.Cleanup(func() { readQuotaHist = old })
	return &n
}

// Each new reading of an account changes the history this process wrote
// last, while the file is still that one: it isn't read and parsed again,
// nor parsed once more before it is written over. A file another process
// wrote since is read, and one that doesn't parse is still kept aside.
func TestQuotaHistoryWrittenNotReadAgain(t *testing.T) {
	testenv.SetHome(t, t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t0 := time.Date(2026, 10, 3, 8, 0, 0, 0, time.UTC)
	r5, rw := t0.Add(3*time.Hour), t0.Add(4*24*time.Hour)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	reads := countReads(t)

	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 10, r5, 40, rw)}, at(0))
	for m := 10; m <= 60; m += 10 {
		noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", float64(m), r5, 40, rw)}, at(m))
	}
	if *reads != 1 {
		t.Fatalf("six new readings read the history file %d times after the first", *reads-1)
	}
	five := lineOf(t, QuotaHistories(t0.Add(-time.Hour), "", ""), "a@x.com", "5 hours")
	if len(five) != 7 || five[6].Left != 40 {
		t.Fatalf("5 hours points = %+v", five)
	}

	// another process writes the file: its history is read and kept
	path := quotaHistPath()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(filepath.Dir(path), "other.json")
	if err := os.WriteFile(other, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(other, path); err != nil {
		t.Fatal(err)
	}
	mb, err := json.Marshal(quotaHist{quotaHistKey("codex", "b@x.com"): {"5 hours": {{At: at(5), Left: 50}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := MergeQuotaHistory(mb, at(70)); err != nil {
		t.Fatal(err)
	}
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 70, r5, 40, rw)}, at(70))
	hs := QuotaHistories(t0.Add(-time.Hour), "", "")
	if p := lineOf(t, hs, "a@x.com", "5 hours"); len(p) != 8 {
		t.Fatalf("a's points after another write = %+v", p)
	}
	if p := lineOf(t, hs, "b@x.com", "5 hours"); len(p) != 1 {
		t.Fatalf("b's points = %+v", p)
	}

	// a file that doesn't parse, written over ours, is kept aside first
	if err := os.WriteFile(other, []byte(`{"cut`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(other, path); err != nil {
		t.Fatal(err)
	}
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 80, r5, 40, rw)}, at(80))
	if bad, _ := filepath.Glob(path + ".bad-*"); len(bad) != 1 {
		t.Fatalf("the unparsed file kept aside as %v", bad)
	}
}

// A process that writes the file where it is, not by renaming one over it,
// makes it a different file too (its size, or its time): the history this
// process wrote isn't used for it, and what it holds is kept.
func TestQuotaHistoryFileWrittenInPlaceIsRead(t *testing.T) {
	testenv.SetHome(t, t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t0 := time.Date(2026, 10, 3, 8, 0, 0, 0, time.UTC)
	r5, rw := t0.Add(3*time.Hour), t0.Add(4*24*time.Hour)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	reads := countReads(t)

	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 10, r5, 40, rw)}, at(0))
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 20, r5, 40, rw)}, at(10))
	if *reads != 1 {
		t.Fatalf("a reading of the history this process wrote read the file %d times", *reads-1)
	}

	path := quotaHistPath()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var h quotaHist
	if err := json.Unmarshal(b, &h); err != nil {
		t.Fatal(err)
	}
	h[quotaHistKey("codex", "c@x.com")] = map[string][]QuotaPoint{"5 hours": {{At: at(2), Left: 70}}}
	if b, err = json.Marshal(h); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 30, r5, 40, rw)}, at(20))
	if *reads != 2 {
		t.Fatalf("the file another process wrote where it was read %d times, want once", *reads-1)
	}
	hs := QuotaHistories(t0.Add(-time.Hour), "", "")
	if p := lineOf(t, hs, "c@x.com", "5 hours"); len(p) != 1 {
		t.Fatalf("c's points = %+v", p)
	}
	if p := lineOf(t, hs, "a@x.com", "5 hours"); len(p) != 3 {
		t.Fatalf("a's points = %+v", p)
	}
}

// A reading whose write fails isn't kept as the file's: the file is as it
// was, and the next reading reads it again, with what it holds, not the
// history that never reached it.
func TestQuotaHistoryWriteFailureNotHeld(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("a folder that refuses a new file refuses it only to a user, and only off Windows")
	}
	testenv.SetHome(t, t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t0 := time.Date(2026, 10, 3, 8, 0, 0, 0, time.UTC)
	r5, rw := t0.Add(3*time.Hour), t0.Add(4*24*time.Hour)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	reads := countReads(t)

	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 10, r5, 40, rw)}, at(0))
	if *reads != 1 {
		t.Fatalf("the first reading read the history file %d times", *reads)
	}
	path := quotaHistPath()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// the folder refuses a new file: the write of the reading at 10 fails
	dir := filepath.Dir(path)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Chmod(dir, 0o700); err != nil {
			t.Error(err)
		}
	}()
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 20, r5, 40, rw)}, at(10))
	if after, err := os.ReadFile(path); err != nil {
		t.Fatal(err)
	} else if !bytes.Equal(after, b) {
		t.Fatal("a write that failed changed the file")
	}

	// the file's own history is read again, not the one that didn't reach it
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var h quotaHist
	if err := json.Unmarshal(b, &h); err != nil {
		t.Fatal(err)
	}
	h[quotaHistKey("codex", "c@x.com")] = map[string][]QuotaPoint{"5 hours": {{At: at(2), Left: 70}}}
	if b, err = json.Marshal(h); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 30, r5, 40, rw)}, at(20))
	if *reads != 2 {
		t.Fatalf("after a write that failed, the next reading read the file %d times, want once", *reads-1)
	}
	hs := QuotaHistories(t0.Add(-time.Hour), "", "")
	if p := lineOf(t, hs, "a@x.com", "5 hours"); len(p) != 2 || !p[1].At.Equal(at(20)) || p[1].Left != 70 {
		t.Fatalf("a's points = %+v, want the file's and this reading's, not the one that didn't get written", p)
	}
	lineOf(t, hs, "c@x.com", "5 hours")
}

// A reading that cannot be encoded must not keep its in-memory changes
// as the file's history either: a later valid reading can still be saved.
func TestQuotaHistoryMarshalFailureNotHeld(t *testing.T) {
	testenv.SetHome(t, t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t0 := time.Date(2026, 10, 3, 8, 0, 0, 0, time.UTC)
	r5, rw := t0.Add(3*time.Hour), t0.Add(4*24*time.Hour)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	reads := countReads(t)
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 10, r5, 40, rw)}, at(0))
	before, err := os.ReadFile(quotaHistPath())
	if err != nil {
		t.Fatal(err)
	}
	// time.Time can hold this reset, but JSON's RFC3339 cannot.
	badReset := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 20, badReset, 40, rw)}, at(10))
	if after, err := os.ReadFile(quotaHistPath()); err != nil {
		t.Fatal(err)
	} else if !bytes.Equal(after, before) {
		t.Fatal("a reading that cannot be encoded changed the file")
	}
	noteQuotaHistory([]SubscriptionQuota{histCard("A@x.com", 30, r5, 40, rw)}, at(20))
	if *reads != 2 {
		t.Fatalf("after a marshal failure read the file %d times, want twice", *reads)
	}
	hs := QuotaHistories(t0.Add(-time.Hour), "", "")
	if p := lineOf(t, hs, "a@x.com", "5 hours"); len(p) != 2 || !p[1].At.Equal(at(20)) || p[1].Left != 70 {
		t.Fatalf("points after a valid reading = %+v; want only the two saved readings", p)
	}
}
