package usage

// The fork keeps final Codex effort answers, rather than upstream's daily
// effortSplit index. A warm Sessions list and overview need separate periods.
import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/sessions"
)

const effortDiskPeriods = 4

// This format is deliberately distinct from upstream's effort-v1.json: the
// fork never wrote that format and has no old entry to migrate.
type effortDiskFile struct {
	Version int
	Entries []effortDiskEntry
}

type effortDiskEntry struct {
	Period Period
	Key    string
	Value  map[string][]sessions.ModelEffort
}

func effortDiskPath() string {
	return filepath.Join(filepath.Dir(sessions.CachePath()), "moepie-effort-v1.json")
}

// effortDiskKey covers the same inputs as requestState.key, replacing its
// process-local log version with the parsed log's content hash. Parser code,
// identities, prices, source files, shared days and the actual window all
// matter. An unreadable or incomplete log is unknown, never an empty log.
func effortDiskKey(st requestState, p Period, now time.Time) string {
	s := st.snapshot
	if s == nil {
		return ""
	}
	if s.info == nil {
		if _, err := os.Stat(s.path); !os.IsNotExist(err) {
			return ""
		}
	} else if s.hash == "" || s.off != s.info.Size() {
		return ""
	}
	h := sha256.New()
	for _, root := range strings.Split(st.root, "|") {
		root, err := filepath.Abs(root)
		if err != nil {
			return ""
		}
		fmt.Fprintf(h, "%q;", filepath.Clean(root))
	}
	fmt.Fprintf(h, "%q;%q;%q;%q;%q;%q;%q;%d;", requestDiskBinary(), st.meta, p,
		p.Since(now).Format(time.RFC3339Nano), p.Until(now).Format(time.RFC3339Nano),
		now.In(time.Local).Format("2006-01-02 MST"), s.hash, s.off)
	hashCodexIdentities(h, st.codexIdentities)
	for _, src := range st.sources {
		fmt.Fprintf(h, "%q:%q:%q:%d:%d;", src.Path, src.Key, src.Agent, src.Size, src.Modified.UnixNano())
	}
	for _, day := range st.days {
		fmt.Fprintf(h, "%q:%q:%q:%d:%d;", day.path, day.computer, day.day, day.size, day.mod.UnixNano())
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

// Readers and writers run under codexEffortBuilding. Another process may
// replace the file and lose an entry, but each surviving entry still has to
// match its own complete input key; a lost write can only cause a miss.
func readEffortDisk() []effortDiskEntry {
	b, err := os.ReadFile(effortDiskPath())
	if err != nil {
		return nil
	}
	var file effortDiskFile
	if json.Unmarshal(b, &file) != nil || file.Version != 1 || len(file.Entries) > effortDiskPeriods {
		return nil
	}
	return file.Entries
}

func loadEffortDisk(key string) map[string][]sessions.ModelEffort {
	if key != "" {
		for _, entry := range readEffortDisk() {
			if entry.Key == key && entry.Value != nil {
				return entry.Value
			}
		}
	}
	return nil
}

func saveEffortDisk(key string, p Period, value map[string][]sessions.ModelEffort) {
	if key == "" || value == nil {
		return
	}
	entries := []effortDiskEntry{{Period: p, Key: key, Value: value}}
	for _, entry := range readEffortDisk() {
		if entry.Period != p && entry.Value != nil {
			entries = append(entries, entry)
			if len(entries) == effortDiskPeriods {
				break
			}
		}
	}
	b, err := json.Marshal(effortDiskFile{Version: 1, Entries: entries})
	if err != nil {
		return
	}
	// Like requests-v1.bin, publish a complete private temp file by rename.
	path := effortDiskPath()
	if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}
	out, err := os.CreateTemp(filepath.Dir(path), "effort-*.tmp")
	if err != nil {
		return
	}
	defer os.Remove(out.Name())
	_, err = out.Write(b)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		_ = os.Rename(out.Name(), path)
	}
}
