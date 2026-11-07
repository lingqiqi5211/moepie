package redact

import (
	"runtime"
	"strings"
	"testing"
)

// Long histories must not be copied for each known module. This covers
// the original #4766 path and its non-ASCII and whitespace follow-ups.
func TestMissingModuleReadsOnlyTheWordsBeforeTheQuote(t *testing.T) {
	const name = "drizzle-orm"
	for _, prefix := range []string{
		strings.Repeat("x", 400000) + " Cannot find module ",
		strings.Repeat("找不到模块", 30000) + "：Cannot find module ",
		strings.Repeat("x", 1000) + " Cannot find module" + strings.Repeat(" ", 100),
		"İSTANBUL " + strings.Repeat("x", 128) + " No module named ",
		strings.Repeat("x", 200000) + " Can't resolve ",
	} {
		s := prefix + "'" + name + "'"
		a := len(prefix) + 1
		if !missingModuleAt(s, a, a+len(name)) {
			t.Fatalf("module not recognized after %d bytes", len(prefix))
		}
		runtime.GC()
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		missingModuleAt(s, a, a+len(name))
		runtime.ReadMemStats(&after)
		if made := after.TotalAlloc - before.TotalAlloc; made > 8<<10 {
			t.Fatalf("module lookup allocated %d bytes, want at most 8 KiB", made)
		}
	}
	for _, prefix := range []string{
		strings.Repeat("x", 200000) + " ",
		strings.Repeat("x", 200000) + " Cannot find moduleX",
	} {
		s := prefix + "'" + name + "'"
		a := len(prefix) + 1
		if missingModuleAt(s, a, a+len(name)) {
			t.Fatal("ordinary quoted value mistaken for a missing module")
		}
	}
}
