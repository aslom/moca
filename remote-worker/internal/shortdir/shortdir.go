// Package shortdir makes the temporary directories that hold Unix sockets in tests.
//
// It exists because of a conflict between two constraints. A Unix socket path is bounded by
// sockaddr_un.sun_path -- 104 bytes on macOS, 108 on Linux -- and `bind` fails with EINVAL (or
// silently truncates) past it, so these directories have to be SHORT. But hardcoding "/tmp", as
// these tests used to, fails outright wherever /tmp is not writable: a sandboxed or hardened
// environment, a CI image that points TMPDIR elsewhere, or a user without write access to /tmp.
// `go test` itself honours TMPDIR, so hardcoding /tmp also meant the Go tests ignored the one knob
// everything else in the repo respects.
//
// So: prefer TMPDIR when it is set AND short enough to leave room for a socket, and fall back to
// the operating system's default (os.MkdirTemp's "", which is TMPDIR or /tmp) otherwise. Either
// way the caller gets a directory it can put a socket in, or a test failure that says why.
package shortdir

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// MaxSocketPath is the smaller of the two platform limits for sockaddr_un.sun_path, so a path that
// fits here fits everywhere this code runs. The real limit is 104 on macOS and 108 on Linux.
const MaxSocketPath = 104

// budget is how much room a caller's own filenames may need under the directory we return: a
// generous allowance for `MkdirTemp`'s random suffix plus something like "/control.sock".
const budget = 40

// New returns a directory for a test's Unix sockets, removed when the test ends.
//
// It tries each candidate in turn and takes the first that is short enough AND writable, so a
// read-only /tmp or an over-long TMPDIR costs a fallback rather than a failure. If none works the
// test fails naming every candidate and why, which is the information needed to fix the
// environment -- far better than `bind` failing later with a bare EINVAL.
func New(t *testing.T, prefix string) string {
	t.Helper()
	dir, err := Make(prefix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// Make is New without the testing dependency, for the conformance harness and anything else that
// is not a test. The caller owns the cleanup.
func Make(prefix string) (string, error) {
	var tried []string
	for _, base := range candidates() {
		if len(base)+budget > MaxSocketPath {
			tried = append(tried, fmt.Sprintf("%s (%d bytes, too long)", base, len(base)))
			continue
		}
		dir, err := os.MkdirTemp(base, prefix)
		if err != nil {
			tried = append(tried, fmt.Sprintf("%s (%v)", base, err))
			continue
		}
		return dir, nil
	}
	return "", fmt.Errorf(
		"shortdir: no directory short enough (limit %d) and writable for a Unix socket; tried: %s",
		MaxSocketPath, strings.Join(tried, "; "),
	)
}

// candidates lists the parent directories to try, in order of preference: TMPDIR first, because it
// is the knob the rest of the repo honours and the one a sandbox sets; then /tmp, which is short
// and usually writable; then the Go default, which is TMPDIR-or-/tmp but may differ on platforms
// where neither applies. Duplicates and empties are dropped so the error message lists each place
// once.
func candidates() []string {
	var out []string
	seen := map[string]bool{}
	for _, d := range []string{os.Getenv("TMPDIR"), "/tmp", os.TempDir()} {
		if d == "" {
			continue
		}
		// MkdirTemp joins without adding a separator, so a trailing slash would double it in the
		// path and in the length check.
		d = filepath.Clean(d)
		if seen[d] {
			continue
		}
		seen[d] = true
		out = append(out, d)
	}
	return out
}
