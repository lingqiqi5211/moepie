//go:build !windows

package datamove

import (
	"fmt"
	"os"
	"syscall"
)

func rootIdentity(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	raw, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("cannot identify source root: %s", path)
	}
	return fmt.Sprintf("%d:%d", raw.Dev, raw.Ino), nil
}
