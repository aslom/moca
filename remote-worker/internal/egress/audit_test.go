package egress

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestRedactPathDropsQueryFragmentUserinfo(t *testing.T) {
	u, _ := url.Parse("http://u:p@h/a%20b?token=s#f")
	if got := RedactPath(u); got != "/a%20b" {
		t.Fatalf("got %q", got)
	}
	u2, _ := url.Parse("http://h")
	if got := RedactPath(u2); got != "/" {
		t.Fatalf("got %q", got)
	}
	if got := RedactPath(nil); got != "/" {
		t.Fatalf("nil: got %q", got)
	}
}

func TestJSONSinkWritesOneLinePerEvent(t *testing.T) {
	var b bytes.Buffer
	s := NewJSONSink(&b)
	s.Emit(Event{VMID: "vm1", SID: "s1", Host: "a.com", Method: "CONNECT", Status: 200, Decision: DecisionTunnel, Via: "spoof"})
	s.Emit(Event{VMID: "vm1", SID: "s1", Host: "b.com", Method: "GET", Path: "/x", Decision: DecisionForward})
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines=%d: %q", len(lines), b.String())
	}
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("%q: %v", l, err)
		}
		if m["via"] != "moca-egress" {
			t.Fatalf("via=%v", m["via"])
		}
		if m["time"] == "0001-01-01T00:00:00Z" {
			t.Fatal("time not filled")
		}
	}
}
