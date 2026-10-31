package datamove

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The desktop joins before WebView2 exists. Windows puts every descendant
// in this job atomically at creation, including children created during quit.
// There is deliberately no kill-on-close or breakaway flag. We never discover
// or kill other browsers by name, nor mistake a released profile lock for exit.
var browserTracking struct {
	sync.Once
	job   windows.Handle // held for the GUI's lifetime, not inherited as a handle
	proof *BrowserProof
	err   error
}

const browserJobPrefix = `Local\magpie-data-browser-`

var browserKernel = windows.NewLazySystemDLL("kernel32.dll")
var openBrowserJob = browserKernel.NewProc("OpenJobObjectW")
var processInBrowserJob = browserKernel.NewProc("IsProcessInJob")
var errOutsideBrowserJob = errors.New("process is outside the window's browser job")

func processCreated(h windows.Handle) (uint64, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), nil
}

// TrackBrowserWriters runs once, before the first native browser is created.
// A failure leaves the ordinary GUI usable, but Bind refuses a migration.
func TrackBrowserWriters() {
	browserTracking.Do(func() {
		// A timed-out helper restarts inside the still-strict job. Reuse it
		// so a retry also waits for the preceding GUI's remaining writers.
		if exe, err := os.Executable(); err == nil {
			if tx, err := Status(exe); err == nil && tx != nil && tx.Browser != nil {
				job, err := openWriterJob(tx.Browser.Job)
				if err != nil && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
					browserTracking.err = err
					return
				}
				if err == nil {
					flags, err := browserJobFlags(job)
					if err == nil && flags == 0 {
						// Also covers a manual reopen while an old writer survives.
						if inBrowserJob(windows.CurrentProcess(), job) != nil {
							err = windows.AssignProcessToJobObject(job, windows.CurrentProcess())
						}
						var created uint64
						if err == nil {
							created, err = processCreated(windows.CurrentProcess())
						}
						if err == nil {
							browserTracking.job = job
							browserTracking.proof = &BrowserProof{Job: tx.Browser.Job, PID: uint32(os.Getpid()), Created: created}
							return
						}
					}
					windows.CloseHandle(job)
					if err != nil {
						browserTracking.err = err
						return
					}
				}
			}
		}
		var token [16]byte
		if _, err := rand.Read(token[:]); err != nil {
			browserTracking.err = err
			return
		}
		name := browserJobPrefix + hex.EncodeToString(token[:])
		wide, err := windows.UTF16PtrFromString(name)
		if err != nil {
			browserTracking.err = err
			return
		}
		job, err := windows.CreateJobObject(nil, wide)
		if err != nil {
			if job != 0 {
				windows.CloseHandle(job)
			}
			browserTracking.err = err
			return
		}
		created, err := processCreated(windows.CurrentProcess())
		if err == nil {
			err = windows.AssignProcessToJobObject(job, windows.CurrentProcess())
		}
		if err != nil {
			windows.CloseHandle(job)
			browserTracking.err = err
			return
		}
		browserTracking.job = job
		browserTracking.proof = &BrowserProof{Job: name, PID: uint32(os.Getpid()), Created: created}
	})
}

// BindBrowserWriters persists the job identity before the helper handshake.
func BindBrowserWriters(exe, id string) error {
	if browserTracking.err != nil {
		return fmt.Errorf("track the window's browser writers: %w", browserTracking.err)
	}
	if browserTracking.proof == nil {
		return errors.New("the window's browser writers were not tracked before startup")
	}
	unlock, err := lockFor(exe, 30*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	tx, err := Status(exe)
	if err != nil {
		return err
	}
	if tx == nil || tx.ID != id || tx.Helper != 0 {
		return ErrNoMove
	}
	proof := *browserTracking.proof
	tx.Browser = &proof
	return save(exe, tx)
}

func openWriterJob(name string) (windows.Handle, error) {
	if !strings.HasPrefix(name, browserJobPrefix) || len(name) != len(browserJobPrefix)+32 {
		return 0, errors.New("invalid browser job name")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(name, browserJobPrefix)); err != nil {
		return 0, err
	}
	wide, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	r, _, callErr := openBrowserJob.Call(0x0004|0x0002|0x0001, 0, uintptr(unsafe.Pointer(wide))) // QUERY | SET_ATTRIBUTES | ASSIGN_PROCESS
	if r == 0 {
		return 0, fmt.Errorf("open browser job: %w", callErr)
	}
	return windows.Handle(r), nil
}

func browserJobFlags(job windows.Handle) (uint32, error) {
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil)
	return info.BasicLimitInformation.LimitFlags, err
}

func inBrowserJob(process, job windows.Handle) error {
	var in uint32
	r, _, err := processInBrowserJob.Call(uintptr(process), uintptr(job), uintptr(unsafe.Pointer(&in)))
	if r == 0 {
		return err
	}
	if in == 0 {
		return errOutsideBrowserJob
	}
	return nil
}

type browserAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}

func browserActive(job windows.Handle) (uint32, error) {
	var info browserAccounting
	err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil)
	return info.ActiveProcesses, err
}

// browserBarrier opens real process/job handles before acknowledging the helper.
// Creation time and membership bind the proof to this GUI, not a reused PID.
func browserBarrier(tx *Transaction) (func(context.Context) error, func(), error) {
	p := tx.Browser
	if p == nil {
		// Non-desktop callers (the isolated helper fixtures) have no browser.
		// The desktop always binds its proof, and refuses to start otherwise.
		if len(tx.Args) != 0 {
			return nil, nil, errors.New("missing native browser exit proof")
		}
		return func(context.Context) error { return nil }, func() {}, nil
	}
	if p.PID == uint32(os.Getpid()) {
		return nil, nil, errors.New("invalid native browser exit proof")
	}
	job, err := openWriterJob(p.Job)
	if err != nil {
		return nil, nil, err
	}
	closeJob := func() { windows.CloseHandle(job) }
	owner, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, p.PID)
	if err != nil {
		closeJob()
		return nil, nil, fmt.Errorf("open browser owner: %w", err)
	}
	defer windows.CloseHandle(owner)
	created, err := processCreated(owner)
	if err == nil && created != p.Created {
		err = errors.New("browser owner identity changed")
	}
	if err == nil {
		err = inBrowserJob(owner, job)
	}
	if err == nil {
		err = inBrowserJob(windows.CurrentProcess(), job)
	}
	if err == nil {
		var flags uint32
		flags, err = browserJobFlags(job)
		if err == nil && flags != 0 {
			err = errors.New("browser job permits breakaway or has unexpected limits")
		}
	}
	if err != nil {
		closeJob()
		return nil, nil, err
	}
	return func(ctx context.Context) error { return waitBrowserJob(ctx, job, WebWait) }, closeJob, nil
}

func waitBrowserJob(ctx context.Context, job windows.Handle, most time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, most)
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for the window's browser writers: %w", err)
		}
		n, err := browserActive(job)
		if err != nil {
			return fmt.Errorf("query browser writers: %w", err)
		}
		if n == 1 {
			// The helper is the only member. No other member can create another
			// writer now. Let the subsequently restarted GUI escape this job,
			// so successive moves don't accumulate nested jobs. No process is
			// terminated when our last handle closes.
			info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK}}
			_, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
			return err
		}
		if n == 0 {
			return errors.New("browser helper lost its job membership")
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for the window's browser writers: %w", ctx.Err())
		case <-time.After(waitTick):
		}
	}
}
