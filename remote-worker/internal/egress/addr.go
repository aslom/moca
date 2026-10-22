package egress

import (
	"errors"
	"fmt"
	"net/netip"
)

// ErrPrivate is returned for a destination address the proxy must not dial.
var ErrPrivate = errors.New("destination_private")

var (
	cgnat   = netip.MustParsePrefix("100.64.0.0/10")
	thisNet = netip.MustParsePrefix("0.0.0.0/8")
	v4Bcast = netip.MustParseAddr("255.255.255.255")
)

// CheckAddr refuses addresses the proxy must not dial. Link-local unicast,
// unspecified, multicast and broadcast are always refused. Loopback, private,
// CGNAT, 0.0.0.0/8 and any address in local are refused unless inside a permit
// prefix. v4-mapped IPv6 forms are classified as IPv4.
func CheckAddr(a netip.Addr, permit []netip.Prefix, local []netip.Addr) error {
	a = a.Unmap().WithZone("")
	if !a.IsValid() || a.IsUnspecified() || a.IsLinkLocalUnicast() || a.IsMulticast() ||
		a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() || a == v4Bcast {
		return fmt.Errorf("%w: %s", ErrPrivate, a)
	}
	if a.Is6() {
		// Deprecated forms, never dialled: IPv4-compatible (::/96, except ::1,
		// which is plain loopback) and site-local.
		if (v4Compat.Contains(a) && a != v6Loopback) || siteLocal.Contains(a) {
			return fmt.Errorf("%w: %s", ErrPrivate, a)
		}
		// Embedded IPv4 is judged as if it were dialled directly.
		b := a.As16()
		var embedded []netip.Addr
		switch {
		case nat64.Contains(a):
			embedded = append(embedded, netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
		case nat64Local.Contains(a):
			// Last 32 bits, and the RFC 6052 /48 layout (bytes 6,7 and 9,10).
			embedded = append(embedded,
				netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}),
				netip.AddrFrom4([4]byte{b[6], b[7], b[9], b[10]}))
		case sixToFour.Contains(a):
			embedded = append(embedded, netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
		}
		for _, e := range embedded {
			if err := CheckAddr(e, permit, local); err != nil {
				return fmt.Errorf("%w: %s embeds %s", ErrPrivate, a, e)
			}
		}
	}
	restricted := a.IsLoopback() || a.IsPrivate() || cgnat.Contains(a) || thisNet.Contains(a)
	if !restricted {
		for _, l := range local {
			if l.Unmap().WithZone("") == a {
				restricted = true
				break
			}
		}
	}
	if !restricted {
		return nil
	}
	for _, p := range permit {
		if p.Contains(a) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrPrivate, a)
}

var (
	v4Compat   = netip.MustParsePrefix("::/96")
	siteLocal  = netip.MustParsePrefix("fec0::/10")
	nat64      = netip.MustParsePrefix("64:ff9b::/96")
	nat64Local = netip.MustParsePrefix("64:ff9b:1::/48")
	sixToFour  = netip.MustParsePrefix("2002::/16")
	v6Loopback = netip.MustParseAddr("::1")
)
