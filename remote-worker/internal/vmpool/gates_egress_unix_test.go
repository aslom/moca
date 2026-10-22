//go:build unix

package vmpool

import (
	"context"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress"
	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// mapResolver resolves only the names it holds; anything else is NXDOMAIN-shaped.
type mapResolver map[string]netip.Addr

func (m mapResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if a, ok := m[host]; ok {
		return []netip.Addr{a}, nil
	}
	return nil, fmt.Errorf("no such host %q", host)
}

// recordingAudit keeps every audit event in memory.
type recordingAudit struct {
	mu sync.Mutex
	ev []egress.Event
}

func (r *recordingAudit) Emit(e egress.Event) { r.mu.Lock(); r.ev = append(r.ev, e); r.mu.Unlock() }
func (r *recordingAudit) events() []egress.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]egress.Event(nil), r.ev...)
}

// TestGateEgressThroughVsock drives the whole P4.1 path with a real guest: guest bash ->
// 127.0.0.1:3128 -> vsock 1025 -> the jail's v.sock_1025 -> an in-process moca-egress
// proxy (registered through the real control socket) -> a host upstream. It also asserts
// the chroot is in force (the sibling-socket gate, P4.1 section 10) and that Destroy
// leaves no egress socket behind.
//
// Firecracker arm only: the egress socket is a Firecracker vsock UDS in the jail.
func TestGateEgressThroughVsock(t *testing.T) {
	requireKVM(t)
	if v := envOr("SH_VMM", "firecracker"); v != "firecracker" {
		t.Skipf("SH_VMM=%q: the egress vsock transport is a Firecracker-arm feature", v)
	}

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("hello"))
	}))
	defer up.Close()
	_, port, err := net.SplitHostPort(up.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	allow, err := egress.ParseAllow("up.test:" + port)
	if err != nil {
		t.Fatal(err)
	}
	audit := &recordingAudit{}
	proxy, err := egress.NewProxy(egress.Config{
		Allow:                 allow,
		PermitCIDRs:           []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")},
		MaxConnsPerVM:         8,
		MaxRequestsPerSession: 100,
		Resolver:              mapResolver{"up.test": netip.MustParseAddr("127.0.0.1")},
		Credentials:           egress.NoCredentials{},
		Audit:                 audit,
	})
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	defer proxy.Close()

	// Short path: the control socket and the jail's v.sock_1025 both live under sun_path's limit.
	sockDir, err := os.MkdirTemp("/tmp", "egk")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(sockDir)
	sock := filepath.Join(sockDir, "c.sock")
	srv, err := control.NewServer(sock, []int{os.Getuid()}, proxy)
	if err != nil {
		t.Fatalf("control.NewServer: %v", err)
	}
	go func() { _ = srv.Serve() }()
	defer srv.Close()
	client := control.NewClient(sock)
	defer client.Close()

	var chrootBase string
	lc := fcLauncherWith(t, func(o *FirecrackerOptions) {
		o.Egress = client
		chrootBase = o.ChrootBase
	})

	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-egress-gate", Key: "egress-gate", WorkspaceDir: t.TempDir(), GuestRAMBytes: 256 << 20,
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	defer func() { _ = vm.Destroy() }()
	if err := vm.Resume(context.Background()); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	// Sibling-socket gate: the VMM must be chrooted into exactly this VM's jail, so it cannot
	// reach another VM's v.sock_1025. The VM handle is package-internal, so type-assert it.
	fvm, ok := vm.(*firecrackerVM)
	if !ok {
		t.Fatalf("Restore returned %T, want *firecrackerVM", vm)
	}
	pid := fvm.cmd.Process.Pid
	root, err := os.Readlink(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		t.Fatalf("readlink /proc/%d/root: %v", pid, err)
	}
	if root != fvm.jailRoot {
		t.Errorf("firecracker pid %d root = %q, want its own jail %q (the chroot is not in force)", pid, root, fvm.jailRoot)
	}

	// A VM serves exactly one Run, so both requests go in one guest command, split by a marker.
	hostport := "up.test:" + port
	raw := func(target, host string) string {
		return fmt.Sprintf(`( exec 3<>/dev/tcp/127.0.0.1/3128; `+
			`printf 'GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' >&3; cat <&3 )`, target, host)
	}
	script := raw("http://"+hostport+"/hi?k=v", hostport) + "; echo; echo ==SPLIT==; " +
		raw("http://evil.test/", "evil.test")
	var out capturingSink
	if _, err := vm.Run(context.Background(), Command{Command: "bash -c " + shQuote(script), TimeoutS: 30, CapBytes: OutputCapBytes}, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	allowed, denied, found := strings.Cut(out.out(), "==SPLIT==")
	if !found {
		t.Fatalf("guest output has no split marker:\n%s", out.out())
	}
	if !strings.Contains(allowed, " 200") || !strings.Contains(allowed, "hello") {
		t.Errorf("allowed request: want a 200 and hello, got:\n%s", allowed)
	}
	if !strings.Contains(denied, " 403") || !strings.Contains(denied, "destination_denied") {
		t.Errorf("evil.test: want a 403 with destination_denied, got:\n%s", denied)
	}

	// The audit event is emitted when the proxied connection finishes, which can trail the
	// guest seeing EOF, so poll briefly.
	var sawForward bool
	for i := 0; i < 50 && !sawForward; i++ {
		for _, e := range audit.events() {
			if e.Decision == egress.DecisionForward && e.SID == "egress-gate" && e.Path == "/hi" {
				sawForward = true
			}
		}
		if !sawForward {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if !sawForward {
		t.Errorf("no forward audit event with sid=egress-gate path=/hi; events: %+v", audit.events())
	}

	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	var left []string
	_ = filepath.WalkDir(chrootBase, func(p string, _ fs.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(filepath.Base(p), "v.sock_1025") {
			left = append(left, p)
		}
		return nil
	})
	if len(left) > 0 {
		t.Errorf("egress sockets remain under %s after Destroy: %v", chrootBase, left)
	}
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
