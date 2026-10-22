// Package conformance is the black-box conformance suite for the moca-egress
// contract (MI1 docs/specs/2026-09-28-moca-multi-user-isolation-design.md,
// section 12.3). Any implementation of the contract, moca-egress first and
// Cortex later (MI1 S6), runs the same named cases against its external
// interfaces only:
//
//   - the MOCA_EGRESS_* and MOCA_TENANCY environment variables;
//   - the section 8.3 control protocol, driven here by a fake vmpool that hands
//     each VM's listening socket over with control.Client;
//   - the per-VM HTTP/1.1 proxy socket (CONNECT and absolute-form http://);
//   - named refusals (X-Moca-Egress-Error, a "<code>: <host>\n" text/plain body);
//   - one JSON audit event per line on the implementation's stdout.
//
// The package lives outside internal/ on purpose: Go's import rule would
// otherwise stop any other module from ever running it. It does not import
// moca-egress itself. A Target starts an implementation; ProcessTarget execs a
// binary, and cmd/moca-egress-conformance is the runnable form.
//
// Every case brings its own fake DNS server (MOCA_EGRESS_RESOLVER), fake
// upstreams on 127.0.0.1 (permitted with MOCA_EGRESS_PERMIT_CIDRS where a case
// needs to reach them), a fresh control socket and a fresh instance.
//
// This is the transport slice (P4.1, docs/specs/2026-09-15-p4-1-microvm-egress-transport-design.md):
// there is no TLS interception and no credential yet. The section 12.3 cases
// that need interception are deferred to the interception slice (MI1 S2):
//
//   - the placeholder is always overwritten, and a credential is never sent to
//     a non-matching host;
//   - no_credential answers 401 with zero upstream requests;
//   - an inner Host that differs from the CONNECT host answers 421;
//   - a plain-HTTP request to a host with a credential answers
//     403 plaintext_credential, with nothing injected;
//   - an SNI that differs from the CONNECT host is refused;
//   - an upstream certificate failure on an intercepted host answers
//     502 upstream_unverified, not a tunnel;
//   - a grant that expires mid-connection;
//   - exactly one audit event per injection.
//
// The cases themselves are unix-only, because the control protocol passes the
// listener with SCM_RIGHTS. On other platforms the package is empty.
package conformance
