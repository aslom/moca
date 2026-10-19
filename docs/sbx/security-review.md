# SBX0 security review: the 1c gate

The [SBX0 spec](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md) §9 makes a security
review the gate before the internal cohort opens (increment 1c). This document is that review's
**input and its record**: a checklist with a pointer to the evidence for each item, the claims SBX0
makes and what each rests on, what it does not claim, and the reviewer's sign-off. The review
itself is a human step: nothing here is signed off until §5 is filled in.

**Evidence status**, used throughout:

- **Tested**: a named automated test asserts it, and it ran green on the date given. "Mutation"
  adds that deleting or weakening the check made a test fail.
- **By construction**: no test asserts it; it follows from code or a contract this change does not
  touch, named in the row. The reviewer reads the pointer.
- **Live (Task 10)**: only the live acceptance against a deployed namespace can show it (spec
  §10.6). Pending until that run, which records its results in the row.

Verified on 2026-10-19, on the branch at the commit that adds this file, unless a row says
otherwise. Test paths are relative to the repository root.

## 1. The checklist (spec §9, "Reviewed before the cohort opens")

### 1.1 The relay's verifier, against §10.2's matrix, with mutation evidence

On every `Exec` and `Abort`, before routing, the relay refuses a token that does not verify, and an
`Exec` outside the token's own worker and workspace (spec §3.2).

| §10.2 case                                                                   | Evidence (`packages/sandbox-relay/test/sandbox-token.transport.test.ts` unless named)                                                                                       | Status            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `alg: none`; unknown `kid`; wrong `typ`; wrong `aud`; wrong `iss`            | "refuses an Exec with %s, UNAUTHENTICATED, before routing" (table rows of the same names)                                                                                   | Tested + mutation |
| expired outside the leeway; inside it accepted                               | the same table ("a token expired beyond the leeway"); "accepts a token expired by less than the 30 s leeway"                                                                | Tested + mutation |
| missing `exec` scope; bad signature                                          | the same table ("a missing exec scope", "a tampered signature")                                                                                                             | Tested + mutation |
| an API or session token presented as a sandbox token                         | the same table ("an API token…", "a session token…")                                                                                                                        | Tested + mutation |
| `sandbox_id` ≠ `wrk`; `workspace_key` ≠ `wsk`, a prefix, an extension, empty | "refuses an Exec on %s, PERMISSION_DENIED, before routing" (another worker / workspace / prefix / extension / empty key)                                                    | Tested + mutation |
| `Abort` of another `sbx`'s Exec; of a finished Exec; on another worker       | "refuses to Abort another sandbox's Exec…", "refuses to Abort a finished Exec…", "refuses an Abort for the right req_id on another worker"                                  | Tested + mutation |
| per-sandbox `req_id` (§3.6): same id and command from two sandboxes          | "runs the same req_id and command from two sandboxes as two worker Execs…"; "maps B's Abort of a shared req_id to B's own Exec, never A's"                                  | Tested + mutation |
| no Exec outlives its token (§3.6)                                            | the expiry tests (aborted at `exp` + leeway, `DEADLINE_EXCEEDED`; the timer cleared when the Exec ends first)                                                               | Tested + mutation |
| the in-flight cap (§3.6)                                                     | "admits two, refuses a third RESOURCE_EXHAUSTED before routing, and admits again after one ends"                                                                            | Tested + mutation |
| the harness token first in precedence; none in an SBX0 relay                 | "checks the harness token first…" (mutation); `deploy/sbx/tests/overlay.test.sh` "the relay takes sandbox tokens and nothing else (no exec token, no static client tokens)" | Tested + mutation |

**Mutation evidence.** 1b's Task 6 deleted or weakened each of the 24 checks in turn (the token
checks in `packages/control-plane/src/token.ts` and `sandbox-token.ts`, the relay's rules in
`packages/sandbox-relay/src/main.ts`), and every mutant made at least one test in
`sandbox-token.transport.test.ts` or `sandbox-auth.test.ts` fail: **24/24 killed** (2026-10-16).
1c's Task 7 then moved the relay's rules into `sandbox-caller.ts` and `exec-stream.ts`. So, for
this review, the same 24 mutants were re-applied at their new sites and re-run on 2026-10-19:
**24/24 killed again**, every source file byte-identical afterwards (checked with `cmp`), and the
relay suite 194/194 green. The mutant list and the tests each one failed are kept with the plan's
working files, not in the repository.

### 1.2 The `sandbox` profile mounts no harness route (spec §4.1)

| Item                                                                 | Evidence                                                                                                                                | Status         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| every route declares its profiles; one added without a profile fails | `packages/control-plane/test/route-profile.test.ts` "declares a non-empty profile list on every route"                                  | Tested         |
| under `sandbox`, every harness-only route is the unknown-path 404    | the same file, "answers every harness-only route with the unknown-path 404 under the sandbox profile"                                   | Tested         |
| under `harness`, every sandbox route is a 404                        | the same file, "answers every sandbox-only route with the unknown-path 404 under the harness profile"                                   | Tested         |
| shared routes are exactly the probes, discovery and login            | the same file, "shares exactly the probe, discovery and login routes between the two profiles"                                          | Tested         |
| the deployed control plane runs the `sandbox` profile                | `deploy/sbx/tests/overlay.test.sh` "the control plane runs the sandbox profile with only its signing key and the janitor token mounted" | Tested         |
| the deployed profile, from outside                                   | a harness route (for example `/v1/sessions`) on `https://<api host>` answers 404                                                        | Live (Task 10) |

### 1.3 Ownership returns 404, and the allowlist gates every route

| Item                                                                                       | Evidence                                                                                                                                                                                                | Status         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| every `/v1/sandboxes/{id}` route hides another user's sandbox as `sandbox_not_found` (404) | `packages/control-plane/test/route-authz-enumeration.test.ts` "makes EVERY sandbox-scoped route hide another user's sandbox with sandbox_not_found"                                                     | Tested         |
| every such route is declared sandbox-scoped, and only those                                | the same file, "declares every /v1/sandboxes/{id} route sandbox-scoped, and only those"                                                                                                                 | Tested         |
| an admin cannot mint for another user's sandbox (404)                                      | `packages/control-plane/test/sandbox-handlers.test.ts` "never mints for an admin on another user's sandbox: 404 sandbox_not_found"                                                                      | Tested         |
| an unlisted subject is refused `not_enrolled` on login and on every sandbox route          | `packages/control-plane/test/sandbox-enrollment.test.ts` "refuses a device-flow login by an unlisted subject…"; `sandbox-handlers.test.ts` "refuses everything to a subject who is not enrolled"        | Tested         |
| a removed subject is stopped at the next refresh, its refresh family revoked               | `sandbox-enrollment.test.ts` "stops a de-enrolled subject at the next refresh", "revokes the family of a de-enrolled refresh…"                                                                          | Tested         |
| the janitor route takes only the janitor bearer; 401 when unset                            | `route-profile.test.ts` "serves the janitor read only with the janitor bearer", "refuses the janitor read to everyone when SH_JANITOR_TOKEN is unset", "never takes the janitor bearer as a user token" | Tested         |
| user B cannot reach user A's sandbox in a deployment (`PERMISSION_DENIED` and 404)         | spec §10.6 step 2                                                                                                                                                                                       | Live (Task 10) |

### 1.4 The routes' exposure

The exec and attach Routes are reachable from the internal network; every exec call needs a valid
sandbox token (§1.1), and every attach its worker's relay token.

| Item                                                                                     | Evidence                                                                                                                                                                                                             | Status         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| attach and exec Routes are passthrough (gRPC never crosses the router's TLS termination) | `deploy/sbx/tests/overlay.test.sh` "the attach and exec Routes are passthrough"; "two ghostunnel sidecars: attach -> :9443, exec -> :9444"                                                                           | Tested         |
| the API Route is edge-terminated, to the control plane only                              | the same file, "the API Route is edge-terminated, to the control plane"                                                                                                                                              | Tested         |
| the only ingress to the relay and control plane is the router namespace, on their ports  | the same file, "the only ingress to the relay pods is the router namespace, on 8444 and 8445", "the only ingress to the control plane is the router namespace, on 8080"                                              | Tested         |
| no in-cluster relay Service; the exec listener on loopback                               | the same file, "no in-cluster relay Service…", "the exec listener is bound to loopback, so only the sidecar reaches it"                                                                                              | Tested         |
| the control plane has no Kubernetes API egress                                           | the same file, "the control plane has no Kubernetes API egress (6443)"                                                                                                                                               | Tested         |
| each worker attaches with its own relay token; a dropped worker is revoked               | `deploy/sbx/tests/setup.test.sh` "creates every Secret and ConfigMap, one worker token per worker, no exec or client tokens", "dropping a worker revokes its token and deletes its bundle (via explicit null patch)" | Tested         |
| the deployed Routes refuse an exec without a token, and an attach without a worker token | spec §10.6 step 2; the attach refusal is seen in `install-host.sh`'s wait when a token is wrong                                                                                                                      | Live (Task 10) |

### 1.5 Secrets out of argv, logs and the audit; secrets not pushed

| Item                                                                                | Evidence                                                                                                                                                                                                     | Status                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `setup.sh` puts no token or key in argv or its log                                  | `deploy/sbx/tests/setup.test.sh` "no token or key reaches argv or the log"                                                                                                                                   | Tested                                                                   |
| the janitor's token stays out of argv and the log; a readable token file is refused | `deploy/sbx/tests/janitor.test.sh` "one JSON summary line…; the token never in argv"; "refuses … a token file others can read…"                                                                              | Tested                                                                   |
| the audit line has no command text, output or token (unless the debug flag)         | `packages/sandbox-relay/test/audit.transport.test.ts` "writes one line with the caller, the outcome and the stdout size, and no command or output"; "adds the command only with SH_SANDBOX_AUDIT_COMMANDS=1" | Tested + mutation (1c Task 7: 33/33 killed, 2026-10-18; not re-run here) |
| an unverified token's claims are never logged                                       | the same file, "records UNAUTHENTICATED as refused with the verifier reason and NO sub or sbx, even when the token parsed"                                                                                   | Tested                                                                   |
| `.env*`, `*.pem`, `*.key`, `id_*` are not pushed unless asked                       | `packages/mocactl/test/sbx-push.test.ts` "lists tracked files … never ignored ones or secrets"; "includes the secrets only when asked, and matches each pattern on the basename"                             | Tested                                                                   |
| `status.sh` is read-only                                                            | `deploy/sbx/tests/status.test.sh` "cluster: read-only…", "host: … read-only"                                                                                                                                 | Tested                                                                   |

## 2. What SBX0 claims (spec §9), and the evidence

| Claim                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No process survives a call                                                   | P4's `TestGateNoVMReuse` and `TestGateLeakFreeTeardown` (`remote-worker/internal/vmpool/gates_kvm_test.go`), unchanged by SBX0                                                                                                                                                                                                                                                                                             | By construction here; those gates need `/dev/kvm` and run only on the rig (`.github/workflows/microvm-kvm-gates.yml`, manual). Not re-run for this review                                           |
| No network in the guest                                                      | P4's Firecracker launcher issues no `PUT /network-interfaces` (`remote-worker/internal/vmpool/launcher_firecracker.go`), unchanged by SBX0                                                                                                                                                                                                                                                                                 | By construction. Not part of the live smoke's steps; a reviewer can check it by hand (`mocactl sbx run -- python3 -c 'import socket; socket.create_connection(("example.invalid", 443), 3)'` fails) |
| A user reaches only their own sandboxes                                      | §1.1 (exact `wrk`/`wsk`, per-sandbox `req_id`, `Abort` ownership), §1.3 (404 on others)                                                                                                                                                                                                                                                                                                                                    | Tested + mutation; deployed: Live (Task 10, §10.6 step 2)                                                                                                                                           |
| An admin cannot exec into another user's sandbox                             | §1.3 (owner-only mint, 404 for an admin)                                                                                                                                                                                                                                                                                                                                                                                   | Tested                                                                                                                                                                                              |
| Tokens never enter the guest                                                 | The relay forwards `ExecRequest {sandbox_id, exec}` only (`proto/sandbox/v1/sandbox.proto`: `Exec` has no token field), and the worker never receives the caller's metadata; unchanged by SBX0                                                                                                                                                                                                                             | By construction                                                                                                                                                                                     |
| Access ends at expiry (30 s leeway), and within one token lifetime of delete | `packages/control-plane/test/sandbox-handlers.test.ts` "refuses to mint once deleted (with the reason) or expired…"; `packages/control-plane/test/sandbox-token.test.ts` "caps exp at the sandbox expiry, and refuses to mint for an ended sandbox", "accepts 30 s of clock skew past exp, and no more"; the relay's leeway and expiry cancel (§1.1). One token lifetime is `SBX_TOKEN_TTL_MINUTES`, 15 minutes by default | Tested; deployed: Live (Task 10, §10.6 step 4)                                                                                                                                                      |

## 3. What SBX0 does not claim

- **Defense against a compromised relay.** The worker does not re-verify tokens; a relay that is
  compromised can run anything in any workspace on its workers. That is increment 3.
- **Revocation faster than one token lifetime.** A deleted sandbox, or a removed user, stays
  reachable for up to one token lifetime plus 30 s (15.5 minutes by default).
- **Durability beyond one host.** Losing the KVM host, or its disk, loses every sandbox on it.
- **Isolation once a user re-enables local tools.** If a user turns an agent's built-in tools back
  on (in this repository or in user-level or managed settings, which `mocactl sbx doctor` does not
  read), the agent acts on the laptop.
- **Data protection on the shared host.** Users' code sits on one shared KVM host. The user guide
  says to push internal code only and no secrets; `sbx up` leaves common secret files out, but
  cannot recognize every secret.

## 4. Open items for the reviewer

- **The live rows** (marked Live (Task 10)) are pending until the live acceptance run against the
  deployed namespace; it records its results here.
- **The P4 gates** behind "no process survives a call" were not re-run for this review; they are
  unchanged by SBX0 and run on the KVM rig.
- **Signing-key rotation** replaces the key outright (`deploy/sbx/RUNBOOK.md` §6): outstanding
  tokens fail within one token lifetime. The two-key form of spec §4.3 is not implemented.
- **The deaf-worker slot hold** (spec §3.6): a wedged worker holds a sandbox's in-flight slot until
  its attach stream drops. An availability limit, not a confidentiality one.

## 5. Reviewer sign-off

| Field    | Entry |
| -------- | ----- |
| Reviewer |       |
| Date     |       |
| Findings |       |
| Decision |       |
