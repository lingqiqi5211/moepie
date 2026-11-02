//go:build !windows

package update

// Only a Windows magpie is opened from a folder the user watches, so a
// download is never staged beside one here (StageBinary puts it in the
// cache).
func isDownloadFolder(string) bool { return false }

// exeVersion is 0: only Windows writes a version into a program's
// resources.
func exeVersion(string) uint64 { return 0 }

// hide does nothing: a name starting with a dot is hidden already.
func hide(string) {}
