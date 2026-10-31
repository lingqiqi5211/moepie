//go:build !windows

package cli

import (
	"runtime"
	"strings"

	"github.com/yetone/magpie/internal/proc"
)

// notice tells a window user, who sees no terminal, why magpie stopped:
// with the system's dialog where there is one, else only on stderr.
func notice(title, body string) {
	quote := strings.NewReplacer(`\`, `\`, `"`, `\"`).Replace
	switch {
	case runtime.GOOS == "darwin":
		proc.Command("osascript", "-e", `display alert "`+quote(title)+`" message "`+quote(body)+`" as critical`).Run()
	case found("zenity"):
		proc.Command("zenity", "--error", "--title", title, "--text", body).Run()
	case found("kdialog"):
		proc.Command("kdialog", "--title", title, "--error", body).Run()
	}
}

func found(name string) bool {
	_, err := proc.LookPath(name)
	return err == nil
}
