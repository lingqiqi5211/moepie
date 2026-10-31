package datamove

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestEnterReleasesEveryRoot(t *testing.T) {
	e := exe(t)
	dirs := []string{filepath.Join(filepath.Dir(e), "data"), filepath.Join(os.Getenv("HOME"), "config")}
	end, err := Enter(context.Background(), dirs)
	if err != nil {
		t.Fatal(err)
	}
	end()
	for _, dir := range dirs {
		entries, err := os.ReadDir(filepath.Join(dir, runtimeName))
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.Name() != "gate" {
				t.Errorf("lease retained after release: %s", filepath.Join(dir, runtimeName, entry.Name()))
			}
		}
	}
}
