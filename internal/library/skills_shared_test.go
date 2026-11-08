package library

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/yetone/magpie/internal/agent"
)

func setOmpVersion(t *testing.T, v string) {
	t.Helper()
	was := ompVersion
	ompVersion = func(*agent.Agent) string { return v }
	t.Cleanup(func() { ompVersion = was })
}

func alwaysOf(t *testing.T, name string) []string {
	t.Helper()
	v, err := Read(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range v.Skills {
		if s.Name == name {
			return s.Always
		}
	}
	t.Fatalf("no skill %s in the view", name)
	return nil
}

// usrname1833: Pi reads ~/.agents/skills itself, from 0.54.0 (its
// CHANGELOG, package-manager.js userAgentsSkillsDir), and omp from 11.0.0
// (discovery/agents.ts). A skill kept there is theirs whatever is ticked
// (the lock), and no second link is made in their own folders; an older
// or unknown one is as before.
func TestPiReadsSharedSkillsFromItsVersion(t *testing.T) {
	h := sandbox(t)
	os.RemoveAll(filepath.Join(h, ".config/goose"))
	os.Remove(filepath.Join(h, "bin/goose"))
	os.Remove(filepath.Join(h, "bin/goose.exe"))
	write(t, filepath.Join(h, ".omp/agent/mcp.json"), "{}")
	holdCLI(t, h, "omp")
	shared := filepath.Join(h, ".agents/skills")
	skill(t, filepath.Join(shared, "orch"), "orch", "Orchestrate")
	own := map[string]string{
		"pi":  filepath.Join(h, ".pi/agent/skills/orch"),
		"omp": filepath.Join(h, ".omp/agent/skills/orch"),
	}

	setPiVersion(t, "0.53.0")
	setOmpVersion(t, "10.6.2")
	ok(t)(ImportSkill("orch"))
	ok(t)(SkillAgents("orch", []string{"claude", "pi", "omp"}))
	for _, id := range []string{"pi", "omp"} {
		if !ours(own[id], "orch") {
			t.Errorf("%s before it read ~/.agents/skills hasn't its own link", id)
		}
	}
	a := alwaysOf(t, "orch")
	if slices.Contains(a, "pi") || slices.Contains(a, "omp") || !slices.Contains(a, "codex") {
		t.Errorf("always before: %v", a)
	}

	setPiVersion(t, "0.54.0")
	setOmpVersion(t, "11.0.0")
	ok(t)(Sync())
	for _, id := range []string{"pi", "omp"} {
		if _, err := os.Lstat(own[id]); !os.IsNotExist(err) {
			t.Errorf("%s reads ~/.agents/skills now, yet keeps a second link: %v", id, err)
		}
	}
	a = alwaysOf(t, "orch")
	for _, id := range []string{"pi", "omp", "codex"} {
		if !slices.Contains(a, id) {
			t.Errorf("%s isn't said to have it always: %v", id, a)
		}
	}
	if slices.Contains(a, "claude") {
		t.Errorf("claude reads no ~/.agents/skills: %v", a)
	}

	// a version not known is taken as an older one, as before
	setPiVersion(t, "")
	ok(t)(Sync())
	if !ours(own["pi"], "orch") || slices.Contains(alwaysOf(t, "orch"), "pi") {
		t.Error("a pi of no known version isn't as before")
	}
}
