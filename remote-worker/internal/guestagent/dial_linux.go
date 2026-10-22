//go:build linux

package guestagent

import (
	"fmt"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// dialVsockTimeout bounds the connect: a guest-initiated vsock connect to a host that
// is not listening is reset (E13), but the dial must never wait unboundedly regardless.
const dialVsockTimeout = 10 * time.Second

// DialVsock connects to the vsock peer cid:port and returns a net.Conn, hand-rolled
// like Accept in listen_linux.go (net.FileConn rejects AF_VSOCK; no vsock dependency).
func DialVsock(cid, port uint32) (net.Conn, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("guestagent: vsock socket: %w", err)
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("guestagent: vsock set nonblocking: %w", err)
	}
	// From here f is fd's only owner.
	f := os.NewFile(uintptr(fd), fmt.Sprintf("vsock-dial:%d:%d", cid, port))
	fail := func(err error) (net.Conn, error) {
		_ = f.Close()
		return nil, fmt.Errorf("guestagent: vsock dial %d:%d: %w", cid, port, err)
	}
	if err := f.SetWriteDeadline(time.Now().Add(dialVsockTimeout)); err != nil {
		return fail(err)
	}
	rc, err := f.SyscallConn()
	if err != nil {
		return fail(err)
	}
	var connErr error
	started := false
	if err := rc.Write(func(fd uintptr) bool {
		if !started {
			started = true
			switch e := unix.Connect(int(fd), &unix.SockaddrVM{CID: cid, Port: port}); e {
			case nil:
				return true
			case unix.EINPROGRESS, unix.EAGAIN, unix.EINTR:
				return false // wait for writability
			default:
				connErr = e
				return true
			}
		}
		// Writable again: the connect finished; SO_ERROR says how.
		soErr, e := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_ERROR)
		if e != nil {
			connErr = e
		} else if soErr != 0 {
			connErr = unix.Errno(soErr)
		}
		return true
	}); err != nil {
		return fail(err)
	}
	if connErr != nil {
		return fail(connErr)
	}
	_ = f.SetWriteDeadline(time.Time{})

	remote := vsockAddr{cid: cid, port: port}
	local := vsockAddr{cid: unix.VMADDR_CID_ANY}
	if svm, ok := localSockaddrVM(int(f.Fd())); ok {
		local = vsockAddr{cid: svm.CID, port: svm.Port}
	}
	return &vsockConn{File: f, local: local, remote: remote}, nil
}

// BringUpLoopback sets IFF_UP on "lo". init never does, and the egress listener on
// 127.0.0.1 needs it. Idempotent.
func BringUpLoopback() error {
	s, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("guestagent: loopback socket: %w", err)
	}
	defer unix.Close(s)
	ifr, err := unix.NewIfreq("lo")
	if err != nil {
		return fmt.Errorf("guestagent: loopback ifreq: %w", err)
	}
	if err := unix.IoctlIfreq(s, unix.SIOCGIFFLAGS, ifr); err != nil {
		return fmt.Errorf("guestagent: SIOCGIFFLAGS lo: %w", err)
	}
	flags := ifr.Uint16()
	if flags&unix.IFF_UP != 0 {
		return nil
	}
	ifr.SetUint16(flags | unix.IFF_UP)
	if err := unix.IoctlIfreq(s, unix.SIOCSIFFLAGS, ifr); err != nil {
		return fmt.Errorf("guestagent: SIOCSIFFLAGS lo: %w", err)
	}
	return nil
}
