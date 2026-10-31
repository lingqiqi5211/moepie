package cli

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procMessageBox = windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW")

// notice tells a window user, who sees no terminal, why magpie stopped.
func notice(title, body string) {
	const iconError, foreground, topmost = 0x10, 0x10000, 0x40000
	procMessageBox.Call(0,
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(body))),
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(title))),
		iconError|foreground|topmost)
}
