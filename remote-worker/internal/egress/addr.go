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
	a = a.Unmap()
	if !a.IsValid() || a.IsUnspecified() || a.IsLinkLocalUnicast() || a.IsMulticast() ||
		a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() || a == v4Bcast {
		return fmt.Errorf("%w: %s", ErrPrivate, a)
	}
	restricted := a.IsLoopback() || a.IsPrivate() || cgnat.Contains(a) || thisNet.Contains(a)
	if !restricted {
		for _, l := range local {
			if l.Unmap() == a {
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
