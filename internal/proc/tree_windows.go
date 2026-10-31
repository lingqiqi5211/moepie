package proc

import (
	"errors"
	"os/exec"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// group is a job the command is put in, and every process it starts with
// it; closing the job ends them all, as it does when magpie exits. A
// command that can't be put in one is killed alone.
type group struct {
	job  windows.Handle
	left atomic.Bool // a process of the job outlived the sweep
}

func ownGroup(*exec.Cmd) {}

func (g *group) join(cmd *exec.Cmd) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
		LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE}}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	g.job = job
}

// kill ends the job's processes. Unlike a Unix group, a job takes no new
// process once it is being ended, so nothing can be missed and nothing is
// left to wait on: the channel is closed already.
func (g *group) kill(*exec.Cmd) <-chan struct{} {
	if g.job != 0 {
		_ = windows.TerminateJobObject(g.job, 1)
	}
	return closed
}

var closed = func() chan struct{} { c := make(chan struct{}); close(c); return c }()

// term is never sent: Windows has no signal a console-less process can be
// asked to end by, so Stop kills the job at once.
func (g *group) term(*exec.Cmd) error { return errors.ErrUnsupported }

// sweep ends what the command left in its job and closes it once none of
// the job is left (killFor at most): a process being terminated still holds
// its files until then.
func (g *group) sweep(*exec.Cmd) <-chan struct{} {
	job := g.job
	g.job = 0
	if job == 0 {
		return closed
	}
	_ = windows.TerminateJobObject(job, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer windows.CloseHandle(job)
		for end := time.Now().Add(killFor); ; time.Sleep(5 * time.Millisecond) {
			n, err := activeProcesses(job)
			if err == nil && n == 0 {
				return
			}
			if err != nil || time.Now().After(end) {
				g.left.Store(true)
				return
			}
		}
	}()
	return done
}

// alive is whether a process of the job outlived the sweep.
func (g *group) alive(*exec.Cmd) bool { return g.left.Load() }

// killFor is how long a sweep waits for the job to empty.
var killFor = 10 * time.Second

// jobAccounting is JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, which x/sys
// doesn't define.
type jobAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

// activeProcesses is how many processes of job are running.
func activeProcesses(job windows.Handle) (uint32, error) {
	var info jobAccounting
	err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil)
	return info.ActiveProcesses, err
}
