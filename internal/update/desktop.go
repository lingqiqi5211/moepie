package update

import (
	"os"
	"path/filepath"
	"strings"
)

// Where magpie runs from, as the update sees it: a magpie opened in a
// download folder (the Desktop, Downloads) keeps that folder clear of what
// it writes, and its download goes out of sight (StageBinary).
//
// Upstream reads this for its self-install too (a Windows magpie opened from
// Downloads installs itself in Programs\magpie); this fork drops that, so
// only the Desktop's companion (com.go) and the staging ask.

// downloadFolder says whether dir is one downloads land in: Downloads, the
// Desktop or a temporary folder (an exe opened from inside a zip); not a
// folder inside them, the home folder or Documents. Tests set it.
var downloadFolder = isDownloadFolder

// fileVersion is the version in an exe's resources, 0 when unknown; tests
// set it.
var fileVersion = exeVersion

// samePath says whether two paths name the same file, Windows' way: in
// any case.
func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// sameBytes says whether the files at a and b hold the same bytes.
func sameBytes(a, b string) bool {
	sa, err1 := os.Stat(a)
	sb, err2 := os.Stat(b)
	if err1 != nil || err2 != nil || sa.Size() != sb.Size() {
		return false
	}
	ha, hb := fileHash(a), fileHash(b)
	return ha != "" && ha == hb
}

// inFolder says whether path is dir or lies in it, in any case.
func inFolder(path, dir string) bool {
	if dir == "" || !filepath.IsAbs(dir) {
		return false
	}
	rel, err := filepath.Rel(strings.ToLower(filepath.Clean(dir)), strings.ToLower(filepath.Clean(path)))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
