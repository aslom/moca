//go:build linux || darwin

package control

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	egressv1 "github.com/rossoctl/moca/gen/go/egress/v1"
)

type regCall struct {
	vmID, sid string
	grant     []byte
	ln        net.Listener
}

// recorder is a Handler that records calls. closeOnUnregister makes Unregister close the
// listener it was given, which is what a real moca-egress does.
type recorder struct {
	mu                sync.Mutex
	regs              chan regCall
	unregs            chan string
	listeners         map[string]net.Listener
	closeOnUnregister bool
}

func newRecorder() *recorder {
	return &recorder{regs: make(chan regCall, 16), unregs: make(chan string, 16), listeners: map[string]net.Listener{}}
}

func (r *recorder) Register(vmID, sid string, grant []byte, ln net.Listener) error {
	r.mu.Lock()
	r.listeners[vmID] = ln
	r.mu.Unlock()
	r.regs <- regCall{vmID, sid, grant, ln}
	return nil
}

func (r *recorder) Unregister(vmID string) error {
	r.mu.Lock()
	ln := r.listeners[vmID]
	delete(r.listeners, vmID)
	r.mu.Unlock()
	if ln != nil && r.closeOnUnregister {
		_ = ln.Close()
	}
	r.unregs <- vmID
	return nil
}

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "ectl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	return d
}

func startServer(t *testing.T, path string, uids []int, h Handler) *Server {
	t.Helper()
	s, err := NewServer(path, uids, h)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.Serve() }()
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// vmListener creates a listening unix socket and returns its path and an *os.File for it.
func vmListener(t *testing.T, dir, name string) (string, *net.UnixListener, *os.File) {
	t.Helper()
	p := filepath.Join(dir, name)
	ul, err := net.ListenUnix("unix", &net.UnixAddr{Name: p, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	f, err := ul.File()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close(); _ = ul.Close() })
	return p, ul, f
}

func ctx(t *testing.T) context.Context {
	t.Helper()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return c
}

func recv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for handler call")
		panic("unreachable")
	}
}

func TestRegisterPassesAWorkingListener(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()

	vmPath, _, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	call := recv(t, h.regs)
	if call.vmID != "vm-1" || call.sid != "run-a" {
		t.Fatalf("got %q %q", call.vmID, call.sid)
	}
	accepted := make(chan error, 1)
	go func() {
		conn, err := call.ln.Accept()
		if err == nil {
			conn.Close()
		}
		accepted <- err
	}()
	conn, err := net.Dial("unix", vmPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := recv(t, accepted); err != nil {
		t.Fatalf("handler accept: %v", err)
	}
}

func TestRegisterWithoutAnFdIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	uc := conn.(*net.UnixConn)
	req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Register{
		Register: &egressv1.Register{VmId: "vm-1", Sid: "s"}}}
	err = roundTrip(uc, req, -1)
	var re *RefusalError
	if !errors.As(err, &re) || re.Code != "bad_request" {
		t.Fatalf("want bad_request, got %v", err)
	}
	select {
	case v := <-h.regs:
		t.Fatalf("handler saw %v", v)
	default:
	}
}

func TestRegisterWithANonListeningSocketIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	err = c.Register(ctx(t), "vm-1", "s", nil, f)
	var re *RefusalError
	if !errors.As(err, &re) || re.Code != "bad_request" {
		t.Fatalf("want bad_request, got %v", err)
	}
}

func TestServerRefusesAPeerOutsideAllowedUIDs(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid() + 1}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()
	_, _, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "s", nil, f); err == nil {
		t.Fatal("register succeeded for a disallowed uid")
	}
	select {
	case v := <-h.regs:
		t.Fatalf("handler saw %v", v)
	default:
	}
}

func TestControlDisconnectUnregistersItsBindings(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	_, _, f1 := vmListener(t, dir, "vm1.sock")
	_, _, f2 := vmListener(t, dir, "vm2.sock")
	for id, f := range map[string]*os.File{"vm-1": f1, "vm-2": f2} {
		if err := c.Register(ctx(t), id, "s", nil, f); err != nil {
			t.Fatal(err)
		}
		recv(t, h.regs)
	}
	c.Close()
	got := map[string]bool{recv(t, h.unregs): true, recv(t, h.unregs): true}
	if !got["vm-1"] || !got["vm-2"] {
		t.Fatalf("unregistered %v", got)
	}
}

func TestClientReplaysRegistrationsAfterServerRestart(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h1 := newRecorder()
	h1.closeOnUnregister = true // proves the client's dup keeps the socket alive
	s1 := startServer(t, ctlPath, []int{os.Getuid()}, h1)
	c := NewClient(ctlPath)
	defer c.Close()

	vmPath, ul, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	recv(t, h1.regs)

	// The caller drops its own copy; only the client's dup remains.
	f.Close()
	ul.SetUnlinkOnClose(false)
	ul.Close()

	s1.Close()
	if got := recv(t, h1.unregs); got != "vm-1" {
		t.Fatalf("old server unregistered %q", got)
	}

	// Nobody is accepting, but the backlog still takes the connection.
	gap, err := net.Dial("unix", vmPath)
	if err != nil {
		t.Fatalf("dial during gap: %v", err)
	}
	defer gap.Close()

	h2 := newRecorder()
	startServer(t, ctlPath, []int{os.Getuid()}, h2)
	if err := c.Unregister(ctx(t), "vm-other"); err != nil {
		t.Fatal(err)
	}
	call := recv(t, h2.regs)
	if call.vmID != "vm-1" || call.sid != "run-a" {
		t.Fatalf("replayed %q %q", call.vmID, call.sid)
	}
	type res struct {
		conn net.Conn
		err  error
	}
	ch := make(chan res, 1)
	go func() { cn, err := call.ln.Accept(); ch <- res{cn, err} }()
	r := recv(t, ch)
	if r.err != nil {
		t.Fatalf("accept: %v", r.err)
	}
	r.conn.Close()
}

func TestOversizeFrameIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], maxFrame+1)
	if _, err := conn.Write(hdr[:]); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected the server to close the connection")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("server did not close the connection")
	}
	select {
	case v := <-h.regs:
		t.Fatalf("handler saw %v", v)
	default:
	}
}
