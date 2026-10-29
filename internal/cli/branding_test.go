package cli

import "testing"

func TestMoepieVersionAliases(t *testing.T) {
	cliHome(t)
	beforeVersion, beforeStart := version, startUp
	version = "0.1.2000"
	startUp = func() {}
	t.Cleanup(func() { version, startUp = beforeVersion, beforeStart })
	for _, alias := range []string{"version", "--version", "-v"} {
		out, err := printed(t, func() error { return run([]string{alias}) })
		if err != nil || out != "moepie 0.1.2000\n" {
			t.Fatalf("%s: %q, %v", alias, out, err)
		}
	}
}
