package egress

import (
	"errors"
	"net/netip"
	"testing"
)

func pfx(s string) []netip.Prefix { return []netip.Prefix{netip.MustParsePrefix(s)} }

func TestCheckAddrRefusesMetadataEvenWhenPermitted(t *testing.T) {
	for _, s := range []string{
		"169.254.169.254", "::ffff:169.254.169.254", "fe80::1", "0.0.0.0", "::",
		"224.0.0.1", "ff02::1", "255.255.255.255", "::ffff:0.0.0.0",
	} {
		permit := []netip.Prefix{
			netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("fe80::/10"),
			netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0"),
		}
		err := CheckAddr(netip.MustParseAddr(s), permit, nil)
		if !errors.Is(err, ErrPrivate) {
			t.Errorf("CheckAddr(%s) = %v, want ErrPrivate", s, err)
		}
	}
}

func TestCheckAddrPermitsOnlyListedPrivate(t *testing.T) {
	a := netip.MustParseAddr("10.1.2.3")
	if err := CheckAddr(a, nil, nil); !errors.Is(err, ErrPrivate) {
		t.Fatalf("unpermitted 10.1.2.3: %v", err)
	}
	if err := CheckAddr(a, pfx("10.1.0.0/16"), nil); err != nil {
		t.Fatalf("permitted 10.1.2.3: %v", err)
	}
	if err := CheckAddr(a, pfx("10.2.0.0/16"), nil); !errors.Is(err, ErrPrivate) {
		t.Fatalf("other prefix: %v", err)
	}
	if err := CheckAddr(netip.MustParseAddr("::ffff:10.1.2.3"), pfx("10.1.0.0/16"), nil); err != nil {
		t.Fatalf("mapped permitted: %v", err)
	}
	for _, s := range []string{"127.0.0.1", "::1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "fd00::1", "0.1.2.3"} {
		if err := CheckAddr(netip.MustParseAddr(s), nil, nil); !errors.Is(err, ErrPrivate) {
			t.Errorf("%s: %v", s, err)
		}
	}
	local := netip.MustParseAddr("203.0.113.9")
	if err := CheckAddr(local, nil, []netip.Addr{local}); !errors.Is(err, ErrPrivate) {
		t.Fatalf("local: %v", err)
	}
	if err := CheckAddr(netip.MustParseAddr("::ffff:203.0.113.9"), nil, []netip.Addr{local}); !errors.Is(err, ErrPrivate) {
		t.Fatalf("mapped local: %v", err)
	}
	if err := CheckAddr(local, pfx("203.0.113.0/24"), []netip.Addr{local}); err != nil {
		t.Fatalf("permitted local: %v", err)
	}
	for _, s := range []string{"8.8.8.8", "2606:4700::1111", "100.128.0.1"} {
		if err := CheckAddr(netip.MustParseAddr(s), nil, nil); err != nil {
			t.Errorf("public %s: %v", s, err)
		}
	}
}

func TestCheckAddrEmbeddedIPv4(t *testing.T) {
	cases := []struct {
		addr   string
		permit []netip.Prefix
		refuse bool
	}{
		{"::a9fe:a9fe", nil, true},
		{"::a9fe:a9fe", pfx("::/0"), true},
		{"64:ff9b::a9fe:a9fe", pfx("169.254.0.0/16"), true},
		{"2002:a9fe:a9fe::", pfx("169.254.0.0/16"), true},
		{"64:ff9b::a00:1", nil, true},
		{"64:ff9b::a00:1", pfx("10.0.0.0/8"), false},
		{"64:ff9b:1::a00:1", nil, true},
		{"2002:0a00:0001::", nil, true},
		{"2002:7f00:1::", nil, true},
		{"fec0::1", nil, true},
		{"fec0::1", pfx("fec0::/10"), true},
		{"64:ff9b::808:808", nil, false},
		{"2002:808:808::", nil, false},
	}
	for _, c := range cases {
		err := CheckAddr(netip.MustParseAddr(c.addr), c.permit, nil)
		if c.refuse != errors.Is(err, ErrPrivate) {
			t.Errorf("%s: err=%v refuse=%v", c.addr, err, c.refuse)
		}
	}
	if err := CheckAddr(netip.MustParseAddr("64:ff9b::cb00:7109"), nil, []netip.Addr{netip.MustParseAddr("203.0.113.9")}); !errors.Is(err, ErrPrivate) {
		t.Errorf("embedded local: %v", err)
	}
}

func TestCheckAddrZonedLocal(t *testing.T) {
	local := []netip.Addr{netip.MustParseAddr("2001:db8::1")}
	if err := CheckAddr(netip.MustParseAddr("2001:db8::1%eth0"), nil, local); !errors.Is(err, ErrPrivate) {
		t.Fatalf("zoned local: %v", err)
	}
	if err := CheckAddr(netip.MustParseAddr("2001:db8::1"), nil, []netip.Addr{netip.MustParseAddr("2001:db8::1%eth0")}); !errors.Is(err, ErrPrivate) {
		t.Fatalf("zoned entry: %v", err)
	}
}
