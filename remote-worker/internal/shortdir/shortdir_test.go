package shortdir

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewHonoursTmpdirWhenItIsShortEnough(t *testing.T) {
	// A real, short TMPDIR: the directory must land under it, not under the OS default.
	tmp, err := os.MkdirTemp("", "sd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	t.Setenv("TMPDIR", tmp)
	got := New(t, "x")
	if !strings.HasPrefix(got, filepath.Clean(tmp)) {
		t.Fatalf("New ignored TMPDIR: got %q, want a child of %q", got, tmp)
	}
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("New returned a directory that does not exist: %v", err)
	}
}

func TestNewFallsBackWhenTmpdirIsTooLong(t *testing.T) {
	// The whole point of the package: a TMPDIR too long to hold a socket must not be used, or
	// `bind` would fail later with an EINVAL that explains nothing. The fallback has to land
	// somewhere, so this needs a usable /tmp -- the one environment the package cannot invent.
	requireFallback(t)
	long := filepath.Join(os.TempDir(), strings.Repeat("d", MaxSocketPath))
	if err := os.MkdirAll(long, 0o755); err != nil {
		t.Skipf("cannot create a path that long here: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(long) })
	t.Setenv("TMPDIR", long)
	got := New(t, "x")
	if strings.HasPrefix(got, long) {
		t.Fatalf("New used a TMPDIR of %d bytes: %q", len(long), got)
	}
}

// requireFallback skips when no short writable directory exists besides TMPDIR, which is the case
// in a sandbox with a read-only /tmp. The tests that need a FALLBACK cannot run there; the ones
// that only need TMPDIR itself still do, and so does every caller in the real suites.
func requireFallback(t *testing.T) {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "sdprobe")
	if err != nil {
		t.Skipf("no short writable directory to fall back to (/tmp: %v)", err)
	}
	_ = os.RemoveAll(d)
}

func TestNewLeavesRoomForASocketName(t *testing.T) {
	got := New(t, "x")
	if len(got)+budget > MaxSocketPath {
		t.Fatalf("New returned %q (%d bytes), too long for a socket under it", got, len(got))
	}
}

func TestNewWithNoTmpdirUsesTheOsDefault(t *testing.T) {
	// Without TMPDIR the only candidates are /tmp and the Go default, so this needs one of them.
	requireFallback(t)
	t.Setenv("TMPDIR", "")
	got := New(t, "x")
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("New returned a directory that does not exist: %v", err)
	}
}
