package egress

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"strings"
	"sync/atomic"
)

// hopHeaders are removed in both directions (RFC 9110 §7.6.1), together with
// whatever the Connection header names.
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// scrubHeaders removes hop-by-hop headers, the headers Connection names, and
// every X-Moca-* header. Nothing is added.
func scrubHeaders(h http.Header) {
	for _, v := range h["Connection"] {
		for _, f := range strings.Split(v, ",") {
			if f = textproto.TrimString(f); f != "" {
				h.Del(f)
			}
		}
	}
	for _, k := range hopHeaders {
		h.Del(k)
	}
	for k := range h {
		if strings.HasPrefix(strings.ToLower(k), "x-moca-") {
			delete(h, k)
		}
	}
}

// countingBody counts the bytes read through it.
type countingBody struct {
	io.ReadCloser
	n *atomic.Int64
}

func (c countingBody) Read(b []byte) (int, error) {
	n, err := c.ReadCloser.Read(b)
	c.n.Add(int64(n))
	return n, err
}

// keptBody is the guest's request body as handed to the Transport. Close is
// a no-op: the Transport closes the body it sent, and the guest conn still
// needs the remainder drained, boundedly, before its next request.
type keptBody struct{ countingBody }

func (keptBody) Close() error { return nil }

// forward sends one absolute-form http:// request over up, the connection
// already dialled to the checked address, and relays the response. It
// reports whether the guest conn may carry another request.
//
// The round trip uses a Transport made for this one request: its DialContext
// ignores the address and returns up, keep-alives are off and compression is
// off. So no upstream conn is ever pooled, let alone shared between callers,
// and the Transport adds no Accept-Encoding of its own.
func (pc *proxyConn) forward(r *http.Request, up net.Conn, ev Event) bool {
	var handed atomic.Bool
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			if handed.Swap(true) {
				return nil, errors.New("egress: checked upstream already used")
			}
			return up, nil
		},
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: maxHeaderBytes,
	}
	defer tr.CloseIdleConnections()

	out := r.Clone(pc.ctx)
	out.RequestURI = ""
	out.Host = r.URL.Host // the checked target, whatever the Host header said
	out.URL.User = nil
	out.Close = false
	scrubHeaders(out.Header)
	if _, ok := out.Header["User-Agent"]; !ok {
		out.Header["User-Agent"] = []string{""} // suppress Go's default User-Agent
	}
	var bytesUp atomic.Int64
	if r.Body != nil && r.Body != http.NoBody {
		out.Body = keptBody{countingBody{ReadCloser: r.Body, n: &bytesUp}}
	}

	resp, err := tr.RoundTrip(out)
	if err != nil {
		ev.Status, ev.Decision = http.StatusBadGateway, DecisionUpstreamUnreachable
		ev.BytesUp = bytesUp.Load()
		pc.refuse(ev, ev.Host)
		return false
	}
	defer resp.Body.Close()

	scrubHeaders(resp.Header)
	// The guest conn stays open only for a length-delimited response, and
	// Response.Write closes after anything else. resp.Close describes the
	// upstream conn, which is never reused, so it does not bear on this.
	keep := !r.Close && (resp.ContentLength >= 0 || chunked(resp.TransferEncoding))
	resp.Close = !keep
	var bytesDown atomic.Int64
	resp.Body = countingBody{ReadCloser: resp.Body, n: &bytesDown}
	werr := resp.Write(pc.c)

	ev.Status, ev.Decision = resp.StatusCode, DecisionForward
	ev.BytesUp, ev.BytesDown = bytesUp.Load(), bytesDown.Load()
	pc.emit(ev, false)
	if werr != nil || !keep {
		return false
	}
	// Any request body the upstream left unread would be parsed as the next
	// request: drain a bounded amount, else end the conn.
	if r.Body != nil {
		if n, err := io.Copy(io.Discard, io.LimitReader(r.Body, drainLimit+1)); err != nil || n > drainLimit {
			return false
		}
	}
	return true
}

func chunked(te []string) bool { return len(te) > 0 && te[0] == "chunked" }
