package egress

import (
	"bufio"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const connectEstablished = "HTTP/1.1 200 Connection Established\r\n\r\n"

type closeWriter interface{ CloseWrite() error }

// tunnel answers a checked CONNECT and splices opaquely until both directions
// end. Bytes the guest sent behind the CONNECT request, already buffered in
// br, go upstream first because the guest side is read through br.
func (pc *proxyConn) tunnel(up net.Conn, br *bufio.Reader, ev Event) {
	var bytesUp, bytesDown atomic.Int64
	idle := pc.p.cfg.IdleTimeout
	extendWrite(pc.c, idle)
	if _, err := io.WriteString(pc.c, connectEstablished); err == nil {
		splice(pc.c, br, up, idle, &bytesUp, &bytesDown)
	}
	ev.Status, ev.Decision = 200, DecisionTunnel
	ev.BytesUp, ev.BytesDown = bytesUp.Load(), bytesDown.Load()
	pc.emit(ev, true) // suppressed if Unregister aborted the conn
}

// splice copies client→up (reading through cr) and up→client. On EOF in one
// direction the destination's write side is half-closed (or the destination
// closed, if it cannot half-close) and the other direction keeps flowing. A
// copy error tears both conns down. It mirrors the guest forwarder's splice.
//
// idle bounds a direction that goes quiet. It is applied to both legs, and to
// the write side as well as the read side, because a half-closed tunnel leaves
// exactly one leg running: bounding only the guest's reads would leave a
// client that sent CloseWrite and then waits on a silent upstream holding its
// slot indefinitely. The deadline is refreshed per read and per write, so only
// an idle direction expires — and because an expiry is a copy error, it lands
// in the arm that already tears both conns down.
func splice(client net.Conn, cr io.Reader, up net.Conn, idle time.Duration, nUp, nDown *atomic.Int64) {
	var wg sync.WaitGroup
	var once sync.Once
	closeBoth := func() { _ = client.Close(); _ = up.Close() }
	// src names the conn the deadline goes on, which on the guest leg is not
	// the reader: cr buffers what arrived behind the CONNECT request.
	pipe := func(dst net.Conn, src net.Conn, sr io.Reader, n *atomic.Int64) {
		defer wg.Done()
		if err := copyCounted(idleWriter{c: dst, idle: idle}, idleReader{r: sr, c: src, idle: idle}, n); err != nil {
			once.Do(closeBoth)
			return
		}
		if cw, ok := dst.(closeWriter); ok {
			if cw.CloseWrite() != nil {
				once.Do(closeBoth)
			}
		} else {
			_ = dst.Close()
		}
	}
	wg.Add(2)
	go pipe(up, client, cr, nUp)
	go pipe(client, up, up, nDown)
	wg.Wait()
	once.Do(closeBoth)
}

func copyCounted(dst io.Writer, src io.Reader, n *atomic.Int64) error {
	buf := make([]byte, 32*1024)
	for {
		r, err := src.Read(buf)
		if r > 0 {
			w, werr := dst.Write(buf[:r])
			n.Add(int64(w))
			if werr != nil {
				return werr
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
