package proc

import (
	"os"
	"strconv"
	"testing"
	"time"
)

// A child that starts a grandchild and both sleep: a tree with more in it
// than the command.
func init() {
	switch os.Getenv("MAGPIE_TEST_TREE") {
	case "parent":
		exe, _ := os.Executable()
		c := Command(exe, "-test.run=^$")
		c.Env = append(os.Environ(), "MAGPIE_TEST_TREE=child")
		if c.Start() == nil {
			os.Stdout.WriteString(strconv.Itoa(c.Process.Pid) + "\n")
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	case "child":
		time.Sleep(time.Minute)
		os.Exit(0)
	}
}

// Ended confirms the whole tree is gone, the grandchild too, only once the
// tree is waited for and swept; before that it says the tree runs.
func TestEndedWaitsForTheWholeTree(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := Command(exe, "-test.run=^$")
	cmd.Env = append(os.Environ(), "MAGPIE_TEST_TREE=parent")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	tr, err := StartTree(cmd)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	if n, _ := out.Read(buf); n == 0 {
		t.Fatal("the grandchild didn't start")
	}
	if err := tr.Ended(200 * time.Millisecond); err == nil {
		t.Fatal("Ended said a running tree had ended")
	}
	tr.Kill()
	go tr.Wait()
	if err := tr.Ended(20 * time.Second); err != nil {
		t.Fatal(err)
	}
}
