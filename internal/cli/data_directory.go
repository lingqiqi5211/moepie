package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/yetone/magpie/internal/datamove"
	"github.com/yetone/magpie/internal/update"
)

// processDataLease is this process's lease on its data place, held until it
// exits, its window's shutdown included: let go any sooner, a move could
// copy while it still writes.
var processDataLease func()

func needsData(args []string) bool {
	for _, a := range args {
		if a == "-h" || a == "--help" {
			return false
		}
	}
	if len(args) == 0 {
		return true
	}
	switch args[0] {
	case "help", "version", "-v", "--version", "licenses":
		return false
	}
	return true
}

// leaseFree are what agents run for a session or a message, and the
// commands that only ask the running magpie: they check for a move but
// take no lease, which an agent's whole session would hold, keeping a move
// waiting on it.
func leaseFree(args []string) bool {
	switch args[0] {
	case "mcp", "claude-mcp-helper", "statusline", "tools", "tool",
		"healthcheck", "heap", "cpu", "goroutines", "agy", "antigravity-cli":
		return true
	}
	return false
}

// windowEntry is whether args open the window or tray, whose user sees no
// terminal: a start that can't go on says why in a dialog.
func windowEntry(args []string) bool {
	if !hasGUI {
		return false
	}
	if len(args) == 0 || strings.HasPrefix(strings.ToLower(args[0]), "magpie:") {
		return true
	}
	switch args[0] {
	case "app", "gui", "panel", "tray", "-Embedding":
		return true
	}
	return false
}

const dataDirectoryUsage = "usage: magpie data-directory status|cancel"

// dataStartup runs before anything reads or writes magpie's data: it
// settles a move left unfinished and takes this process's lease.
func dataStartup(args []string) error {
	if !needsData(args) {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "data-directory" {
		return dataDirectoryCmd(exe, args[1:])
	}
	if len(args) > 0 && leaseFree(args) {
		return datamove.Check(exe)
	}
	processDataLease, err = datamove.Start(exe)
	if err != nil && windowEntry(args) {
		notice("magpie", err.Error())
	}
	return err
}

func dataDirectoryCmd(exe string, args []string) error {
	if len(args) != 1 {
		return errors.New(dataDirectoryUsage)
	}
	switch args[0] {
	case "status":
		tx, err := datamove.Status(exe)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(tx)
	case "cancel":
		return datamove.Cancel(exe)
	case "migrate":
		// the helper the window starts as it quits (gui/datadir.go)
		return migrate(exe)
	}
	return errors.New(dataDirectoryUsage)
}

// migrate runs the move once the window has exited, then opens the window
// again: on the new place, or on the old one saying why not. A helper that
// never took the move leaves the window be, still open or the GUI's to
// reopen (gui/datadir.go).
func migrate(exe string) error {
	err := datamove.Run(context.Background(), exe)
	if tx, _ := datamove.Status(exe); tx == nil || tx.Helper != os.Getpid() {
		return err
	}
	var lerr error
	if b := update.Bundle(); b != "" {
		lerr = update.OpenBeside(b, true)
	} else {
		lerr = update.StartBeside(exe, true, "settings")
	}
	if lerr != nil {
		notice("magpie", fmt.Sprintf("magpie couldn't open again after moving its data: %v", lerr))
	}
	return err
}
