package egress

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

// AllowEntry is one allowlisted destination. Port 0 means the scheme default:
// 443 for CONNECT, 80 for plain HTTP.
type AllowEntry struct {
	Host     string
	Wildcard bool // Host is a suffix; matches strict subdomains only
	Port     uint16
}

// NormalizeHost lower-cases h, strips exactly one trailing dot and removes
// the brackets of an IPv6 literal. It takes a host only; callers split the
// port off first.
func NormalizeHost(h string) (string, error) {
	if strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = h[1 : len(h)-1]
	}
	h = strings.ToLower(h)
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return "", errors.New("empty host")
	}
	if strings.ContainsAny(h, "/@") || strings.IndexFunc(h, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == 0x85 || r == 0xA0
	}) >= 0 {
		return "", fmt.Errorf("invalid host %q", h)
	}
	return h, nil
}

// ParseAllow parses a comma-separated allowlist. Each item is a hostname or IP
// literal with an optional :port, or *.suffix. Empty items are ignored, but an
// allowlist with no entries is an error.
func ParseAllow(s string) ([]AllowEntry, error) {
	var out []AllowEntry
	for _, item := range strings.Split(s, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		e, err := parseEntry(item)
		if err != nil {
			return nil, fmt.Errorf("allow entry %q: %w", item, err)
		}
		out = append(out, e)
	}
	if len(out) == 0 {
		return nil, errors.New("allowlist is empty")
	}
	return out, nil
}

func parseEntry(item string) (AllowEntry, error) {
	var e AllowEntry
	if strings.Contains(item, "://") || strings.ContainsAny(item, "/@?#") {
		return e, errors.New("scheme, path and userinfo are not allowed")
	}
	host := item
	if strings.HasPrefix(item, "[") {
		if strings.HasSuffix(item, "]") {
			host = item
		} else {
			h, p, err := net.SplitHostPort(item)
			if err != nil {
				return e, err
			}
			host = "[" + h + "]"
			port, err := parsePort(p)
			if err != nil {
				return e, err
			}
			e.Port = port
		}
	} else if i := strings.LastIndexByte(item, ':'); i >= 0 && strings.Count(item, ":") == 1 {
		host = item[:i]
		port, err := parsePort(item[i+1:])
		if err != nil {
			return e, err
		}
		e.Port = port
	}
	if rest, ok := strings.CutPrefix(host, "*."); ok {
		e.Wildcard = true
		host = rest
	} else if strings.Contains(host, "*") {
		return e, errors.New("wildcard must be a leading *.")
	}
	h, err := NormalizeHost(host)
	if err != nil {
		return e, err
	}
	if strings.Contains(h, "*") {
		return e, errors.New("wildcard must be a leading *.")
	}
	if e.Wildcard {
		if _, err := netip.ParseAddr(h); err == nil {
			return e, errors.New("wildcard over an IP literal")
		}
		if strings.Contains(h, ":") {
			return e, errors.New("wildcard over an IP literal")
		}
	}
	e.Host = h
	return e, nil
}

func parsePort(p string) (uint16, error) {
	n, err := strconv.ParseUint(p, 10, 16)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("invalid port %q", p)
	}
	return uint16(n), nil
}

// Allowed reports whether host:port is permitted. connect selects the default
// port (443) for entries without one; otherwise it is 80.
func Allowed(entries []AllowEntry, host string, port uint16, connect bool) bool {
	h, err := NormalizeHost(host)
	if err != nil {
		return false
	}
	def := uint16(80)
	if connect {
		def = 443
	}
	for _, e := range entries {
		want := e.Port
		if want == 0 {
			want = def
		}
		if want != port {
			continue
		}
		if e.Wildcard {
			if strings.HasSuffix(h, "."+e.Host) {
				return true
			}
		} else if h == e.Host {
			return true
		}
	}
	return false
}
