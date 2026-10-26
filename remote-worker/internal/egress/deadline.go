package egress

import (
	"io"
	"net"
	"time"
)

// This file holds the one idle bound shared by both data paths. Everything an
// established connection does — tunnel copies, the forwarded request, its
// response — goes through one of these wrappers, so a connection is closed
// only after `idle` with no byte moving on it, never because a long transfer
// ran out of absolute time.
//
// All three refresh rather than arm once. That distinction is the whole point:
// an absolute deadline would kill a slow but healthy `git clone`, and a
// refreshed one cannot, because every byte pushes it out.
//
// A zero or negative duration is a no-op, so a Config built by hand in a test
// keeps the old unbounded behaviour. NewProxy never leaves the bound zero.

func extendRead(c net.Conn, idle time.Duration) {
	if idle > 0 {
		_ = c.SetReadDeadline(time.Now().Add(idle))
	}
}

func extendWrite(c net.Conn, idle time.Duration) {
	if idle > 0 {
		_ = c.SetWriteDeadline(time.Now().Add(idle))
	}
}

// idleReader refreshes c's read deadline before every read through it. r and c
// are separate because the two are not always the same object: the guest side
// of a tunnel is read through a bufio.Reader that already holds whatever came
// in behind the CONNECT, while the deadline belongs on the conn underneath it.
type idleReader struct {
	r    io.Reader
	c    net.Conn
	idle time.Duration
}

func (r idleReader) Read(b []byte) (int, error) {
	extendRead(r.c, r.idle)
	return r.r.Read(b)
}

// idleWriter refreshes c's write deadline before every write to it. It bounds
// the other half of a stall: a peer that stops reading holds a slot just as
// effectively as one that stops sending.
type idleWriter struct {
	c    net.Conn
	idle time.Duration
}

func (w idleWriter) Write(b []byte) (int, error) {
	extendWrite(w.c, w.idle)
	return w.c.Write(b)
}

// idleConn applies the bound to a conn handed to something that reads and
// writes it on its own schedule — the forward path's Transport, which writes
// the request, reads the response headers and then streams the body without
// the proxy in between. Wrapping the conn covers all three; wrapping the
// response body alone would leave the request write unbounded.
//
// The embedded Conn's own SetDeadline methods stay reachable, and the
// deadlines set here are plain socket deadlines, so they do not collide with
// the Transport's separate ResponseHeaderTimeout timer.
type idleConn struct {
	net.Conn
	idle time.Duration
}

func (c idleConn) Read(b []byte) (int, error) {
	extendRead(c.Conn, c.idle)
	return c.Conn.Read(b)
}

func (c idleConn) Write(b []byte) (int, error) {
	extendWrite(c.Conn, c.idle)
	return c.Conn.Write(b)
}
