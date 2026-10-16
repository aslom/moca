# SBX0: a minimal sandbox service for an internal cohort, on the existing `sandbox/v1` API — Design

Version: 1.0 — October 15, 2026
Status: Proposed
Milestone: **SBX0**, registered in [the milestone registry](README.md) (new `SBX` track).
Decision record: [ADR-0042](../adrs/0042-sbx0-sandbox-service-on-sandbox-v1.md).

Builds on these; it reuses them and redesigns nothing:

- [P4](2026-09-09-p4-microvm-sandbox-design.md) and ADR-0035: `microvm-worker`, golden snapshots, a
  fresh Firecracker VM per `Exec` over a persistent per-key workspace;
- ADR-0024 and `proto/sandbox/v1/sandbox.proto`: the `SandboxExec` / `SandboxWorker` wire contract,
  its limits and its conformance battery;
- [P6.1](2026-10-02-p6-on-kubernetes-slice1-design.md) and
  [P6.2](2026-10-04-p6-on-kubernetes-slice2-design.md): the `deploy/k8s/` bases, the ghostunnel L4
  sidecar behind a passthrough Route, and external KVM hosts whose worker dials the in-cluster relay
  over TLS;
- [MU1](2026-09-08-multi-user-control-plane-design.md) and
  [B14](2026-10-08-b14-long-lived-client-auth-design.md): the control plane's GitHub device-flow
  login, Ed25519 token signer (`token.ts`) and refresh families;
- [MI1](2026-09-28-moca-multi-user-isolation-design.md) §6.1: generalizing the token primitive over
  `typ` and `aud`;
- [`mocactl`](2026-09-25-mocactl-control-plane-client-design.md) and its
  [installer](2026-10-08-mocactl-installer-design.md);
- the sandbox-over-MCP prototype: the MCP server in rossoctl/moca#504 (`packages/sandbox-mcp`,
  including `fewer-execs.ts`), and the relay client tokens and `sbx` CLI on
  `feat/relay-client-tokens`.

The long-term product design for the sandbox service (multi-tenant lifecycle API, a standard data
plane, hosted MCP with OAuth) is the exploratory SBX1 design, which is not in this repository and is
not adopted. SBX0 is deliberately smaller: it is what a small internal cohort needs, built from what
already runs.

> **The one-sentence thesis.** The prototype showed that stock coding agents keep their solve rate
> with every command in a fresh microVM. To let a small internal cohort use that without an SSH
> tunnel or hand-issued tokens, put the existing relay behind TLS in its own namespace, add a small
> sandbox resource and a signed per-sandbox token to a second control-plane instance, and give
> `mocactl` the client side: push and pull, a CLI, and a local MCP server. **No proto change and no
> worker change.**

---

## 0. Decisions taken during design

| Question                  | Decision                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data-plane API            | **`sandbox/v1` as it is** (`SandboxExec.Exec` / `Abort`). No sandboxd adapter and no new standard: the APIs are still evolving, and the cohort can use what MOCA already runs. Additive changes only, under ADR-0024's rules. |
| First users               | **A small internal cohort, on both paths:** coding agents (Claude Code, OpenCode) through MCP, and developers coding against the gRPC API directly.                                                                           |
| Where the front door runs | **A dedicated namespace on a shared OpenShift cluster** (configurable; default `moca-sbx`), separate from any MOCA stack. Workers on the KVM host dial out to it, so the host needs no inbound access.                        |
| Identity                  | **A second control-plane instance** in that namespace, with a `sandbox` route profile: the existing GitHub (github.com) device-flow login, plus a sandbox resource and a new sandbox token. Approach A of three (§12).        |
| Lifecycle                 | **An explicit sandbox resource:** create, list, get, delete, with a fixed absolute lifetime. A token covers exactly one sandbox's workspace, never a prefix.                                                                  |
| Egress                    | **None in SBX0.** Curated templates carry the toolchains. Allowlisted egress (experiment E12, then P4.1's vsock transport) is **the next increment** (§11).                                                                   |
| Templates                 | **One `microvm-worker` per template**, each with its own golden snapshot (`SH_SNAPSHOT_IMAGE`). No worker change.                                                                                                             |
| KVM host                  | **One existing bare-metal KVM host**, best effort. Losing it ends every sandbox on it. Host details are deployment inputs, never in code or docs.                                                                             |
| MCP                       | **Local, inside `mocactl`** (`mocactl sbx mcp`, stdio). No hosted MCP server and no OAuth authorization server in SBX0.                                                                                                       |
| Silent reset (#338)       | **Removed without worker changes**, by invariants (§5.4): the control plane owns lifetime, the worker's idle reclaim is set longer than any sandbox can live, and a janitor frees disk.                                       |

## 1. Scope

**In scope:** increments 1a, 1b and 1c (§11): §2–§10.

- the relay: sandbox-token verification, fail-closed boot without a harness exec token, server
  keepalive, per-Exec audit lines (the prototype's static client tokens are not merged, §3.1);
- the control plane: the `sandbox` route profile, the sandbox store and routes, the sandbox token,
  the subject allowlist and quotas;
- `mocactl sbx`: the command group, the gRPC client, the embedded MCP server, agent configuration;
- `@moca/sandbox-client`: the generated `sandbox/v1` stubs, the gRPC exec client and the seven
  tools, which `mocactl` embeds (§6.4);
- `deploy/k8s/overlays/ocp-sbx`, `deploy/sbx/setup.sh`, per-template worker bundles, the janitor,
  `deploy/sbx/status.sh`;
- tests, a user guide, an API guide and an operator runbook.

**Out of scope** (each is a later increment in §11, or not planned here):

- any change to `sandbox.proto` or to `remote-worker` Go code;
- guest network egress (increment 2);
- immediate revocation, a `Release` frame, worker-side token re-verification, per-host mTLS
  (increment 3);
- a hosted MCP server, MCP OAuth 2.1, dynamic client registration;
- service-built read operations, read coalescing, a single-Exec `edit`;
- rootfs persistence, SDKs, machine (non-human) identities;
- more than one KVM host, host migration, workspace replication;
- extending a sandbox's lifetime.

## 2. Architecture

```
 laptop (internal network)                          shared cluster, namespace <sbx-namespace>
 ┌──────────────────────────────┐                  ┌────────────────────────────────────────────┐
 │ Claude Code / OpenCode        │                  │  Route <api-host> (edge TLS)               │
 │   └ MCP stdio ─┐              │   HTTPS          │   └ control-plane (SH_ROUTE_PROFILE=sandbox)│
 │ mocactl sbx ───┼─ login, create, token ─────────▶│       device flow · sandboxes · token mint │
 │   ├ mcp (Pi tools)           │                  │       store: redis                          │
 │   ├ up/push/pull/run/put     │   gRPC over TLS   │  Route <exec-host> (passthrough)           │
 │   └ gRPC client ─────────────┼─ Exec / Abort ───▶│   └ ghostunnel ─▶ relay :exec              │
 │ own code (proto + token) ────┘                   │       verifies moca-sandbox+jwt (pub keys) │
 └──────────────────────────────┘                  │  Route <attach-host> (passthrough)         │
                                                   │   └ ghostunnel ─▶ relay :attach            │
                                                   │  redis (relay presence, CP store)          │
                                                   └──────────────────▲─────────────────────────┘
                                                                      │ worker dials out, TLS 443
                                                   KVM host ┌─────────┴────────────────────────────┐
                                                            │ sbx-worker@<template> × N            │
                                                            │  microvm-worker + vmpool + Firecracker│
                                                            │ sbx-janitor.timer                    │
                                                            └──────────────────────────────────────┘
```

Every host name, the namespace, the GitHub OAuth client id, the subject lists, the KVM host's address
and paths, and the template list are **deployment inputs** (§8.1). None appears in code, tests or
documentation as a literal.

| Component                                    | Change                                                                                                                                                                | Size                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `@moca/control-plane`                        | A `sandbox` route profile; the sandbox store and routes; the sandbox token; the subject allowlist; quotas (§4, §5)                                                    | Medium, the main new code                            |
| `@moca/sandbox-relay`                        | Sandbox-token verification as a caller kind; boot rule; keepalive; audit lines (§3)                                                                                   | Small; supersedes the prototype's `client-tokens.ts` |
| `@moca/mocactl`                              | `mocactl sbx` (§6), a `sandbox/v1` gRPC client, the embedded MCP server                                                                                               | Medium                                               |
| `@moca/sandbox-client` (new)                 | Generated `sandbox/v1` stubs, the gRPC exec client, and the seven tools over Exec with no Pi dependency; `mocactl`'s second allow-listed workspace dependency (§6.4)  | Small to medium                                      |
| `deploy/k8s/overlays/ocp-sbx`, `deploy/sbx/` | Single-namespace overlay reusing `base/relay.yaml`, `base/control-plane.yaml`, `base/redis.yaml`; no supervisor or sandbox pods; setup, bundles, janitor, status (§8) | Medium, mostly existing patterns                     |
| KVM host                                     | One `microvm-worker` unit per template; snapshots built with `deploy/microvm/build-snapshot.sh`; the janitor                                                          | Operator work, no code                               |
| `sandbox.proto`, `remote-worker`             | **No change**                                                                                                                                                         | —                                                    |

## 3. The relay

### 3.1 Callers

The exec service's caller check (`validateExecToken` in `main.ts`) becomes a caller
classification with two kinds. Precedence, first match wins:

1. **Harness:** `MOCA_RELAY_EXEC_TOKEN`, unchanged and unrestricted. Not configured in an SBX0
   deployment.
2. **Sandbox:** a `moca-sandbox+jwt` token (§4.3) that verifies against
   `SH_SANDBOX_TOKEN_PUBLIC_KEYS`.
3. Otherwise `UNAUTHENTICATED`.

**The prototype's static client tokens are not merged.** `MOCA_RELAY_CLIENT_TOKENS` and
`client-tokens.ts` exist only on the prototype branch `feat/relay-client-tokens`. Increment 1a runs
the relay from that branch, for the team only (§11). On `main`, 1b's sandbox kind replaces them. It
keeps their shape (a caller classification checked before routing) and their Abort-ownership map,
keyed by `sbx` instead of a grant. Code meant to be deleted therefore never lands.

### 3.2 Verifying a sandbox token

On every `Exec` and `Abort`, before routing, so a refused call never reaches a worker:

- the compact JWS parses into exactly three parts; `alg` is `EdDSA`; `typ` is `moca-sandbox+jwt`;
  `kid` names a key in the keyset; the signature verifies;
- `aud` is `moca-sandbox`; `iss` equals `SH_SANDBOX_TOKEN_ISSUER`; `exp` is in the future (30 s
  leeway for clock skew); `scope` includes `exec`;
- **`Exec`:** `req.sandbox_id == wrk` and `exec.workspace_key == wsk`, both exact string equality;
  anything else is `PERMISSION_DENIED`;
- **`Abort`:** permitted only for an `Exec` this relay accepted from a token with the same `sbx`,
  still in flight (the prototype's ownership map, keyed by `sbx` instead of a grant; §3.1).

The relay holds **public keys only**, and does no Redis read for authorization. Verification reuses
`token.ts`'s verify primitive once it is generalized over `typ` and `aud` (MI1 §6.1). If importing
`@moca/control-plane` into the relay is unwanted, the primitive moves to a small shared module both
import. Either way there is one verifier implementation.

### 3.3 Boot rule

The relay boots if **at least one** caller credential is configured: `MOCA_RELAY_EXEC_TOKEN`, or a
non-empty `SH_SANDBOX_TOKEN_PUBLIC_KEYS` that parses as Ed25519 SPKI keys with `kid`s (and
`SH_SANDBOX_TOKEN_ISSUER`). With neither, it refuses to boot, as today. A keyset that fails to parse
is a boot error naming the variable, never a value. Existing checks stay: the exec token must differ
from every sandbox relay token.

### 3.4 Keepalive

Some load balancers in front of cluster routers close a TCP connection after a short idle period
(one was measured at 50 s). An `Exec` whose command prints nothing for that long would die. The
relay's gRPC servers set `grpc.keepalive_time_ms` = 20 000 and `grpc.keepalive_timeout_ms` = 10 000,
so the server pings every open connection. Those are the two keepalive options grpc-js 1.14's server
reads, and it does not police client ping rates, so client pings are never refused. Clients also
ping every 20 s (§6.5). The
attach side already heartbeats.

### 3.5 Audit

One JSON line per `Exec` on completion, to stdout:
`{ts, sub, sbx, wrk, req_id, ms, exit_code, timed_out, truncated, out_bytes, outcome}`, where
`outcome` is `end | error | cancelled | refused`. Command text and output are never logged; an
operator debug flag (`SH_SANDBOX_AUDIT_COMMANDS=1`) adds the command's first 200 bytes. Refusals
(`UNAUTHENTICATED`, `PERMISSION_DENIED`) are logged with the reason and, when the token parsed, its
`sub` and `sbx`.

## 4. Identity

### 4.1 The control plane's `sandbox` route profile

`SH_ROUTE_PROFILE` (`harness`, the default, or `sandbox`) selects which routes `routes.ts` mounts.

- **`sandbox` mounts:** `/healthz`, `/readyz`, `/v1/discovery`, `/v1/auth/device`,
  `/v1/auth/device/token`, `/v1/auth/token`, `/v1/auth/revoke`, `/v1/auth/revoke-all`, `/v1/me`, and
  the routes in §5.1 (including the janitor's, which is refused with 401 unless
  `SH_JANITOR_TOKEN` is configured and presented).
- **It does not mount** sessions, models, credentials, config bundles or `/internal/*`. An unmounted
  route returns 404, the same as an unknown path.
- **`harness` mounts** everything as today, and **not** the §5.1 routes.
- The profile is enforced by an **allow list per profile in `routes.ts`**, not by a deny list, so a
  route added later is unmounted under `sandbox` until someone lists it. A test enumerates every
  route and asserts its profile membership (§10.1).
- In the `sandbox` profile the control plane needs no credential store, KEK, inference settings or
  sandbox namespace, and its config loader does not require them.

`/v1/discovery` under `sandbox` returns `{ profile: "sandbox", exec_endpoint, exec_ca?, templates_url }`,
so `mocactl` needs only the control-plane URL.

### 4.2 Who may use it

- **Login** is the existing GitHub device flow against github.com, with the deployment's own OAuth
  app client id. The subject is the control plane's existing `github:<id>` form.
- **`SH_ALLOWED_SUBJECTS`** (comma-separated subjects, required under `sandbox`) gates the device
  flow's completion and every `/v1/sandboxes*` and `/v1/templates*` call. Any other subject gets
  `403 not_enrolled`. Admins are implicitly allowed.
- **`SH_ADMIN_SUBJECTS`** (existing) may list and delete every sandbox, and read terminated ones.
- **No machine identities in SBX0.** Headless and scripted use runs on the user's own login, through
  its refresh family (30 days idle, 90 days maximum, B14).

### 4.3 The sandbox token

```
header { alg: "EdDSA", kid, typ: "moca-sandbox+jwt" }
claims { iss: <SH_SANDBOX_TOKEN_ISSUER>, aud: "moca-sandbox", sub, tenant,
         sbx,                 // sandbox id, e.g. "sbx-01jab…"
         wrk,                 // worker sandbox_id serving the sandbox's template, e.g. "sbx_py312"
         wsk,                 // the workspace_key; equals sbx
         scope: ["exec"], iat, exp, jti }
```

- **Minted** by `POST /v1/sandboxes/{id}/token`, authenticated with the user's API token.
- **`exp` = min(now + `SH_SANDBOX_TOKEN_TTL_SECONDS` (default 900), the sandbox's `expires_at`).**
- **Pinned `typ` and `aud`:** a session or API token (`aud: harness`) never verifies as a sandbox
  token, and a sandbox token never verifies as either.
- **Signed with the control plane's existing key** (`SH_SESSION_TOKEN_PRIVATE_KEY`); its public half
  goes to the relay as `SH_SANDBOX_TOKEN_PUBLIC_KEYS`. One key per deployment, rotated by adding the
  new `kid` to the relay's keyset before switching the signer.
- **Never in the guest:** the worker receives the `Exec`, not the token, exactly as today.

## 5. Lifecycle

### 5.1 Routes

```
GET    /v1/templates              → [{ id, description, tools }]
POST   /v1/sandboxes              { template, name?, labels? }
                                  → 201 { id, name, template, state, created_at, expires_at, labels }
GET    /v1/sandboxes              own; ?state=ready|terminated; admins: ?all=1
GET    /v1/sandboxes/{id}         own, else 404 (another user's sandbox is indistinguishable from none)
DELETE /v1/sandboxes/{id}         idempotent → 200 { state: terminated, reason: deleted }
POST   /v1/sandboxes/{id}/token   → { token, exp, exec_endpoint, wrk, wsk }
                                  409 sandbox_terminated { reason } once terminated
GET    /v1/janitor/terminated     ?older_than_s=3600 → [{ wsk, wrk, terminated_at }]
                                  Bearer SH_JANITOR_TOKEN only (§8.3); no user token is accepted
```

- **Ids:** `sbx-` plus a lowercase ULID. That satisfies the worker's key rule
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), and the id doubles as the `workspace_key`.
- **`name`** is optional, unique among the user's live sandboxes, `^[a-z0-9][a-z0-9-]{0,62}$`.
- **`labels`** are free-form string pairs (at most 16, 256 bytes each). `mocactl sbx up` uses
  `project=<repo id>` to find the user's sandbox for a repository.
- **Templates** come from `SH_SANDBOX_TEMPLATES`: a JSON list of
  `{ id, worker, description, tools }` mounted from a ConfigMap. `worker` must match the relay's
  sandbox-id rule (`^[A-Za-z_][A-Za-z0-9_]*$`). Create with an unknown template returns
  `400 unknown_template`.
- **Create does no I/O to the worker.** The workspace is created by the first `Exec`. Because `wsk`
  is unique per sandbox, a new sandbox always starts empty.

### 5.2 States

`ready → terminated`, with `reason ∈ { deleted, expired }`.

- **Expiry** is computed, not scheduled: a sandbox whose `expires_at` has passed reads as
  `terminated / expired` on every route and refuses to mint.
- **Terminated records stay readable for 14 days** (`SH_SANDBOX_RETENTION_SECONDS`), so `mocactl sbx ls`
  can say why a sandbox is gone. Then they are deleted.
- **Lifetime is absolute:** `SH_SANDBOX_LIFETIME_SECONDS`, default 7 days. No extension in SBX0.

### 5.3 Quotas

- `SH_SANDBOX_MAX_PER_SUBJECT` (default 3) live sandboxes per user, and `SH_SANDBOX_MAX_TOTAL`
  (default 40) live sandboxes in total. Over either: `429 quota_exceeded`.
- These are **the disk control.** Workspace disk is not admission-controlled on the worker; only VM
  memory is. `setup.sh` checks that `SH_SANDBOX_MAX_TOTAL` × the workspace image size fits the KVM
  host's workspace filesystem (§8.1).
- Concurrency per sandbox is already 1: the worker serializes `Exec`s per workspace.

### 5.4 Invariants that remove the silent reset

1. **The worker never reclaims a live sandbox.** Every SBX0 worker sets `SH_WORKSPACE_IDLE` longer
   than `SH_SANDBOX_LIFETIME_SECONDS` (default 9 days against 7). `setup.sh` refuses otherwise.
   Idle time can't exceed total lifetime, so the worker's idle sweep can only reach a workspace whose
   sandbox has already ended.
2. **Expiry is exact.** No token outlives its sandbox's `expires_at`.
3. **Delete takes effect within one token lifetime** (≤ 15 min): the mint refuses at once, and an
   already-minted token keeps working until its `exp`. This is documented for users. Immediate
   revocation is increment 3.
4. **Disk is freed by the janitor** (§8.3), not by the worker's idle sweep. The janitor also covers
   the workspaces a restarted worker no longer tracks. A worker restart keeps workspaces on disk, so
   a live sandbox's files survive it.

The one remaining way to lose a live sandbox's files is losing the host (or its disk). That is
stated in the user guide as plain text.

### 5.5 Storage

Records live in the namespace's Redis, under `sbx:` keys:

- `sbx:sandbox:<id>`: a hash with the record;
- `sbx:subject:<sub>`: a set of the subject's live ids;
- `sbx:name:<sub>:<name>`: the id, set with `NX` on create.

Quota checks and inserts run in one Lua script, so concurrent creates can't exceed a quota. Redis
persistence follows the existing `base/redis.yaml`.

## 6. Clients: `mocactl sbx`

### 6.1 Commands

| Command                                                                    | Does                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sbx login`                                                                | Device flow against the sbx control plane (config key `sbxControlPlaneUrl`, or `--control-plane-url`). Auth is cached per URL, so it coexists with a MOCA login                                                               |
| `sbx templates`                                                            | Lists templates                                                                                                                                                                                                               |
| `sbx up [--template T] [--name N] [--no-agent-config] [--include-secrets]` | Inside a git repository: reuse the user's live sandbox labelled `project=<repo id>`, or create one. Push the working tree (§6.2). Write `.sbx/sandbox.json` and the agent configuration (§6.3). Print id, template and expiry |
| `sbx push [--force]`                                                       | Push again. Refuses if the sandbox holds changes not yet pulled, unless `--force`                                                                                                                                             |
| `sbx pull [--apply] [-o FILE]`                                             | Capture the patch (§6.2). `--apply` runs `git apply --3way` locally, then advances the sandbox's baseline                                                                                                                     |
| `sbx run [-- CMD…]`                                                        | Runs `CMD`, or the script on stdin, in `/workspace`. Exits with the command's code; 124 means the command timed out, 125 means the sandbox failed                                                                             |
| `sbx put PATH`                                                             | Writes stdin to `PATH` under `/workspace`, creating parent directories                                                                                                                                                        |
| `sbx ls`, `sbx rm [ID]`                                                    | The user's sandboxes, with state, reason, template and expiry; delete                                                                                                                                                         |
| `sbx token [ID]`                                                           | Prints a fresh sandbox token                                                                                                                                                                                                  |
| `sbx env [ID]`                                                             | Prints `export` lines: `SBX_ADDR`, `SBX_SANDBOX_ID` (`wrk`), `SBX_WORKSPACE_KEY` (`wsk`), `SBX_TOKEN_CMD="mocactl sbx token ID"`, and `SBX_CA_FILE` if the endpoint's certificate is self-issued                              |
| `sbx mcp [--sandbox ID]`                                                   | A stdio MCP server bound to one sandbox (§6.4)                                                                                                                                                                                |
| `sbx doctor`                                                               | Checks login; that the sandbox is live and its expiry; that the agent config denies every local tool; one `true` Exec and its latency; work not yet pulled                                                                    |

`ID` defaults to the sandbox in `./.sbx/sandbox.json`, searched upward to the repository root.
`.sbx/` is added to `.git/info/exclude`, never to `.gitignore`.

### 6.2 Push and pull

- **Push.** The file list is `git ls-files --cached --others --exclude-standard`. Files matching
  `.env*`, `*.pem`, `*.key` or `id_*` are excluded with a warning unless `--include-secrets` is given.
  The files are packed as a gzip tar (with no macOS `._*` entries) and sent as one Exec's stdin.
- **In the sandbox**, that Exec empties `/workspace`, extracts, writes a `.git/info/exclude` for
  common build output (`__pycache__/`, `*.pyc`, `node_modules/`, `.venv/`, `venv/`, `.pytest_cache/`,
  `.mypy_cache/`, `dist/`, `build/`, `target/`), and commits a baseline with a fixed identity.
- **The 8 MiB message ceiling** (ADR-0024) bounds one push. A larger tree is split into several
  Execs, each appending to the extraction; the baseline commit runs after the last. A tree over a hard
  cap (`--max-push`, default 256 MiB uncompressed) is refused, naming the largest directories.
- **Pull** runs `git add -A -N . && git diff --binary HEAD` in the sandbox. Output over the 8 MiB cap
  is refused with a message, never truncated silently.
- **`pull --apply`**, after a clean local apply, runs `git add -A && git commit` in the sandbox, so
  the next pull contains only newer changes.
- **"Changes not yet pulled"** is a non-empty `git status --porcelain` in the sandbox.

The extraction uses `tar` if the template has it, and falls back to `python3 -m tarfile` otherwise.
Every curated template ships `tar` and `git` (§8.2).

### 6.3 Agent configuration

`sbx up` writes, **merging into existing files and never overwriting them**:

- **Claude Code:**
  - `.mcp.json` gets `mcpServers.sandbox = { "command": "mocactl", "args": ["sbx", "mcp"] }`;
  - `.claude/settings.json` gets `permissions.allow` `mcp__sandbox__*`, and `permissions.deny` for
    `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`,
    `Agent`, `Task`, `EnterWorktree`, `ExitWorktree`, `Workflow`.
- **OpenCode:** `opencode.json` gets `mcp.sandbox = { "type": "local", "command": ["mocactl", "sbx", "mcp"] }`,
  and `tools` set to `false` for `bash`, `read`, `edit`, `write`, `patch`, `glob`, `grep`, `list`,
  `lsp`, `webfetch`, `websearch`, `task`.
- **`CLAUDE.md` and `AGENTS.md`:** a block between `<!-- sbx:begin -->` and `<!-- sbx:end -->`
  stating that:
  - the code lives in a remote sandbox at `/workspace`;
  - every call is a fresh VM, and no process survives it;
  - files under `/workspace` persist;
  - there is no network;
  - calls run one at a time, so batch the work.

Merging rules:

- JSON keys are added, and existing values are kept. If an existing value conflicts (for example, an
  existing `sandbox` server pointing elsewhere), `sbx up` stops and names the file and key.
- Writing the Markdown block is idempotent.
- `sbx rm` offers to remove exactly what `sbx up` added.
- `sbx doctor` re-checks the deny lists against this section's tool names and reports any built-in
  tool that is still enabled.

The tool names are a list in one module, updated as the agents add tools. That keeps the denied
state checkable (`doctor`) instead of assumed.

### 6.4 The MCP server

- **Transport:** stdio. The server binds to one sandbox at start, from `--sandbox` or
  `.sbx/sandbox.json`. It holds the user's login and refreshes the sandbox token in process before
  `exp`.
- **Tools:** seven, with the **names and input schemas of Pi's** (`bash`, `read`, `write`, `edit`,
  `grep`, `find`, `ls`), so an agent sees the same tool surface MOCA's harness serves. Each costs one
  Exec (`edit` two: read, then write), using the command shapes #504's `fewer-execs.ts` measured.
  Plus `sandbox_info`: template, expiry, and the rules from §6.3.
- **Errors:**
  - A busy sandbox returns the readable message from #504 ("sandbox busy: a command has been running
    for 3m12s; retry later").
  - A terminated sandbox returns "sandbox expired on … / was deleted; run `mocactl sbx up`".
  - Machinery failures come back as tool errors that say so, never as command output.
- **The tool layer lives in a new package, `@moca/sandbox-client`.** It holds:
  - the generated `sandbox/v1` TypeScript stubs, from a second `buf generate` output with the same
    plugin and options as `@moca/k8s-sandbox`'s, so there is no hand-copied generated code;
  - `SandboxExecConn`, the gRPC exec client of §6.5;
  - the seven tools over an `Exec` function, **reimplemented without Pi**. `pi-coding-agent` brings
    its TUI, AI and agent-core packages and a native image library, and ADR-0036's rule exists to
    keep exactly that out of `mocactl`;
  - the MCP server itself (`createSandboxMcpServer`, over `@modelcontextprotocol/sdk`), so
    `mocactl sbx mcp` only wires a stdio transport, the login and the flight recorder to it.
- **The dependency exception.** `mocactl` may depend on one workspace package today
  (`@moca/config-bundle`, ADR-0038), enforced by `layering.test.ts`. `@moca/sandbox-client` becomes
  the **second** allow-listed entry, recorded in ADR-0042. It carries what ADR-0038's justification
  requires: no Pi, no server internals, no substrate assumptions. Its runtime dependencies are
  `@grpc/grpc-js`, `@bufbuild/protobuf` and `@modelcontextprotocol/sdk`.
- **The accepted cost:** two implementations of the seven tools exist, Pi's (the harness) and this
  one (SBX0), until a shared transport-neutral tool layer is extracted. A contract test pins this
  package's tool names and input schemas to Pi's, so the two cannot drift silently (§10.4).
- **Bundle size:** CI records the size of `mocactl.mjs` and fails on growth over a set budget.
- **Flight recorder:** one JSON line per tool call (`ts, tool, ms, execs, exit`) to
  `<mocactl state dir>/sbx/<id>.log`. `doctor` summarizes it.

### 6.5 The gRPC client

- `@grpc/grpc-js`, with the generated `sandbox/v1` stubs, TLS against system roots plus an optional
  CA file, and keepalive every 20 s.
- `req_id` is random and below 2^53. The relay decodes `uint64` as a JavaScript number; this is a
  known wire wart, documented and not fixed in SBX0.
- On `UNAUTHENTICATED` the client refreshes the token once and retries **only if the call never
  started**, that is, before the first event. A started command is never re-run.

## 7. The gRPC API for developers' own code

**Published:**

- `proto/sandbox/v1/sandbox.proto`, unchanged;
- the direct-client guide (`docs/api/sandbox-v1-direct-client.md`), updated for SBX0;
- a Python example client.

**What a client does:**

- Dial `SBX_ADDR` over TLS, and trust `SBX_CA_FILE` if one is given.
- Send `authorization: Bearer <sandbox token>`.
- Set `ExecRequest.sandbox_id = wrk` and `Exec.workspace_key = wsk` exactly.
- Keep `req_id` unique and below 2^53.
- Ping every 20 s.
- Run `SBX_TOKEN_CMD` for a token, and again when it is within 60 s of `exp` or on `UNAUTHENTICATED`.
- Treat `End.exit_code` as the command's outcome, and a non-OK status or `ExecError` as machinery
  failure. These rules are ADR-0024's, unchanged.

**The promise to the cohort:** changes to `sandbox/v1` are additive only, under ADR-0024's rules.
Nothing else is promised.

`docs/api/examples/sbx.py` stays an example of a thin client. `mocactl sbx run` and `put` are the
supported CLI.

## 8. Deployment and operations

### 8.1 `deploy/sbx/setup.sh` and `deploy/k8s/overlays/ocp-sbx`

**Inputs**, all from the environment or flags, and sticky in the same way as `deploy/k8s/setup.sh`:

- the namespace;
- the API, exec and attach route hosts;
- the GitHub OAuth client id;
- `SH_ADMIN_SUBJECTS` and `SH_ALLOWED_SUBJECTS`;
- the template list;
- optional operator TLS certificate and key per route;
- the lifetime, quota and idle settings;
- the KVM host's workspace filesystem size, used for the disk check.

**Generated once and kept**, as Secrets:

- the Ed25519 signing key (private key in the control-plane Secret; public keyset in the relay's);
- self-signed certificates for routes without operator certificates;
- one relay token per template worker, written to the relay's `SH_RELAY_TOKEN_DIR` Secret (P6.2
  §2.1);
- the janitor's token (`SH_JANITOR_TOKEN`, at least 32 random characters, compared in constant
  time). It admits `GET /v1/janitor/terminated` and nothing else, so it can read which workspaces
  to free but cannot create, delete or mint. It is not a user identity, so §4.2's "no machine
  identities" still holds for every user-facing route.

**Output:**

- one bundle per template worker, in P6.2's format (`worker.env`, `relay-ca.crt`, mode 0600 in a
  0700 directory);
- one janitor bundle (`janitor.env`).

**Refuses** to apply if:

- `SH_WORKSPACE_IDLE` ≤ `SH_SANDBOX_LIFETIME_SECONDS`;
- `SH_SANDBOX_MAX_TOTAL` × the workspace image size exceeds 80 % of the workspace filesystem;
- a template's worker id is invalid or listed twice;
- `SH_ALLOWED_SUBJECTS` is empty.

**The overlay:**

- Reuses `base/relay.yaml`, `base/control-plane.yaml` and `base/redis.yaml`, with a single-namespace
  addressing patch (as `ocp-single`).
- Adds a ghostunnel sidecar on the relay for **both** the exec and attach listeners, each behind its
  own passthrough Route, plus an edge Route for the control plane.
- Adds NetworkPolicies admitting only the router to those ports.
- Has no supervisor, sandbox pods or credentials namespace.
- gRPC never crosses the router's TLS termination, so HTTP/2 and trailers survive end to end.

### 8.2 The KVM host

**Per template:**

- a systemd unit `sbx-worker@<worker>` running `microvm-worker`, configured from its bundle;
- its own `SH_SNAPSHOT_IMAGE`, memory budget (`SH_MAX_COMMITTED_MB`) and standby depth;
- the shared `SH_WORKSPACE_IDLE`;
- **its own slice, jail directory and workspace root:** `sbx-<worker>.slice` under a parent
  `sbx.slice` (so `SH_PARENT_CGROUP=sbx.slice/sbx-<worker>.slice`), `SH_CHROOT_BASE` and
  `SH_WORKSPACE_ROOT` under per-worker directories. Never one shared slice: each worker sweeps its
  parent cgroup for orphans at startup (`vmpool/cgroup.go`), so a restart of one worker would kill
  every other worker's VMs.

**Snapshots** are built with `deploy/microvm/build-snapshot.sh` from an OCI image. The curated set
for the cohort, with contents agreed before 1c:

- `default`: today's sandbox image;
- a Python template;
- a Node template.

Each one carries `bash`, `git`, `tar`, `ripgrep` and its toolchain, and is pinned by hash as today.

**`deploy/sbx/install-host.sh <bundle-dir>`** installs or updates one template unit from its bundle.
It touches **only** SBX0's own units, the slice, the janitor and its configured directories, never
another install on the same host. Every change is recorded in a manifest with an undo script.

### 8.3 The janitor

A systemd timer on the KVM host (default every 15 min) that:

1. lists sandboxes terminated more than 1 h ago, through `GET /v1/janitor/terminated` with its
   token (§8.1), keeping only those whose `wrk` is one of this host's template workers;
2. for each, renames `<workspace root of wrk>/<wsk>` to `.reclaiming-<wsk>-<ts>` (the worker's own
   detach-then-remove pattern, so no key can reach the tree), then removes it;
3. removes `.reclaiming-*` trees older than 1 h left by crashed workers;
4. prints one JSON summary line (`ts, examined, removed, bytes_freed, errors`).

It does nothing when the control plane is unreachable, and never removes a directory whose sandbox
is `ready` or unknown to the control plane. An unknown directory is reported, not removed. The
1-hour wait outlasts any token's remaining life (§5.4.3), so no `Exec` can still be using a tree the
janitor removes. The worker's own sweep tolerates the missing directory (`detachWorkspace` handles
`IsNotExist`).

### 8.4 Status and support

`deploy/sbx/status.sh` reports:

- which template workers are attached;
- live and terminated sandbox counts;
- workspace filesystem use;
- the janitor's last summary;
- Exec p50, p95 and error rate over the last hour, from the relay's audit lines.

Support is **best effort, business hours.** A KVM-host outage ends every sandbox on the host.
`mocactl` reports it as "template unavailable", and the user guide says so.

## 9. Security

**Reviewed before the cohort opens** (the 1c gate):

- the relay's verifier, against §10.2's matrix, with mutation evidence;
- the `sandbox` profile mounting no harness route (§4.1);
- ownership returning 404, and the allowlist gating every route;
- the routes' exposure. The exec and attach routes are reachable from the internal network: every
  exec call needs a valid sandbox token, and every attach needs its worker's relay token.

**What SBX0 claims, and the evidence for each:**

| Claim                                              | Evidence                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| No process survives a call                         | P4's `TestGateNoVMReuse`, `TestGateLeakFreeTeardown` (unchanged) |
| No network in the guest                            | P4's launcher configures no network device (unchanged)           |
| A user reaches only their own sandboxes            | §3.2 (exact `wrk`/`wsk`), §5.1 (404 on others), §10.2            |
| Tokens never enter the guest                       | The worker never receives them (unchanged)                       |
| Access ends at expiry, and within 15 min of delete | §4.3, §5.4                                                       |

**What it does not claim:**

- **Defense against a compromised relay.** The worker does not re-verify tokens until increment 3.
- **Revocation faster than one token lifetime.**
- **Durability beyond one host.**

**Data handling.** Users' code sits on one shared KVM host. The user guide says to push internal
code only and no secrets, and `sbx up` excludes common secret files by default (§6.2).

## 10. Testing

### 10.1 Control plane (vitest)

- **The route-profile table:**
  - every route in `routes.ts` belongs to a declared profile;
  - under `sandbox`, every harness route returns 404;
  - under `harness`, every §5.1 route returns 404;
  - a route added without a profile fails the test.
- **The sandbox config loader** needs no credential store or inference settings.
- **Lifecycle:** create, list, get, delete, idempotency, and expiry computed at read time.
- **Retention:** terminated records are deleted after the retention window.
- **Validation:** names (unique, NX) and labels; unknown templates.
- **Quotas:** per subject and total, including concurrent creates, enforced by the Lua script.
- **Allowlist:** login completion and every route return `403 not_enrolled` for an unlisted subject;
  admins pass.
- **Ownership:** 404 for another user's sandbox; admins see everything.
- **The janitor route:**
  - admits only `SH_JANITOR_TOKEN`, and refuses user API tokens, sandbox tokens and admins;
  - returns 401 when the token is unset;
  - returns only terminated sandboxes older than `older_than_s`.
- **Mint:**
  - claims are exactly as §4.3, with `exp` capped at `expires_at`;
  - a terminated sandbox refuses with its reason;
  - an API token works, and a sandbox token presented as an API token is refused.

### 10.2 Relay (vitest)

**The auth matrix.** Each case is refused, and removing its check makes a test fail:

- `alg: none`; an unknown `kid`; a wrong `typ`; a wrong `aud`; a wrong `iss`;
- expired (outside leeway); a missing `exec` scope; a bad signature;
- an API or session token presented as a sandbox token;
- `sandbox_id` ≠ `wrk`; `workspace_key` ≠ `wsk`; `workspace_key` a prefix or extension of `wsk`;
- `Abort` of an `Exec` from another `sbx`; `Abort` of a finished `Exec`.

**Boot:**

- neither credential configured: refused;
- a malformed keyset: refused, naming the variable;
- a keyset only (no harness token): boots;
- the existing clash checks still hold.

**Also:**

- keepalive options are set on the exec server;
- an audit line is written for each outcome and refusal, with no command text unless the debug flag
  is set.

### 10.3 `mocactl sbx` (vitest, against a fake control plane and relay)

- **`up`:** creates or reuses by label; the push file list respects `.gitignore` and the secret
  exclusions; a large tree is chunked; the hard cap is refused.
- **`push`:** refused while changes are not yet pulled; `--force` overrides.
- **`pull`:** produces the patch; `--apply` advances the baseline; an oversized patch is refused.
- **Exit codes:** 124 for a timeout, 125 for a sandbox failure.
- **Refresh-and-retry:** the retry happens only before the first event.
- **Config merge:** existing keys are preserved; a conflict stops with the file and key named; the
  markers are idempotent; `rm` removes exactly what `up` added.
- **`doctor`:** detects a built-in tool that is still enabled.

### 10.4 MCP server and `@moca/sandbox-client`

- each tool against a fake `Exec`: the commands it sends, its result text, its error mapping, and its
  Exec count (1, and 2 for `edit`);
- **the schema contract:** the seven tools' names and input schemas equal Pi's
  (`createBashToolDefinition` and siblings), checked in `@moca/sandbox-client`'s tests, which may
  import Pi as a dev dependency;
- the MCP server's `tools/list` and `tools/call` over an in-memory transport;
- binding from `.sbx/sandbox.json`;
- token refresh mid-session;
- busy, terminated and machinery errors returned as tool errors;
- the `mocactl.mjs` size budget in CI.

### 10.5 Janitor (shell tests, as `deploy/k8s/tests/`)

- removes only directories of sandboxes terminated more than 1 h ago;
- tombstones, then removes;
- tolerates missing directories;
- reports unknown directories and does not remove them;
- does nothing when the control plane is unreachable;
- refuses to run with a workspace root that is `/` or empty.

### 10.6 Live smoke (`SBX_LIVE_SMOKE=1`, against a deployed namespace)

1. `sbx up` → `sbx run` → `sbx pull` round trip on a sample repository.
2. Two users: user B's token and ids cannot reach user A's sandbox (`PERMISSION_DENIED` and 404).
3. A command that prints nothing for 5 minutes completes (keepalive under the load balancer's idle
   cut).
4. Delete, then the mint is refused at once. The last minted token is refused after its `exp`.
5. Headless `claude -p` and `opencode run`, each through `mocactl sbx mcp` with built-ins denied,
   fix a failing test in the sample repository. The laptop's tree is unchanged until
   `sbx pull --apply`, and the suite then passes locally.
6. The janitor frees a deleted sandbox's directory after the wait.

### 10.7 Measured during the cohort

- p50 and p95 per MCP tool and per `sbx run`, from flight recorders (opt-in upload) and relay audit
  lines;
- Exec error rate;
- busy-message frequency.

They are reported after two weeks, and they set the read-latency threshold that later work is held
to.

## 11. Increments

| Inc                           | Lands                                                                                                                                                                                                                                     | Users               | Exit check                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **1a — Front door**           | Namespace, overlay, exec and attach routes with ghostunnel, relay keepalive; one template worker on the KVM host attached over TLS; the relay built from the prototype branch, with static client tokens from a Secret (not merged, §3.1) | Team                | `sbx.py run` works from a laptop on the internal network with no tunnel; §10.6 step 3 passes                               |
| **1b — Identity + lifecycle** | Control plane in `sandbox` profile; §4, §5; relay verification (§3.1–§3.3) on `main`, replacing the prototype relay; `mocactl sbx login, templates, create, ls, rm, token, env` (HTTP only); the Python example client of §7 on `main`    | Team                | §10.1, §10.2 pass; §10.6 steps 2 and 4 pass                                                                                |
| **1c — Usable**               | `@moca/sandbox-client`; `mocactl sbx run, put, up, push, pull, mcp, doctor`; agent configuration; curated templates; janitor; audit lines; status; user guide, API guide, runbook; security review (§9)                                   | **Internal cohort** | §10.3–§10.6 pass; a new user goes from install to `sbx pull --apply` using only the user guide                             |
| **2 — Egress**                | E12, then P4.1's vsock egress transport with an operator allowlist of package registries                                                                                                                                                  | Cohort              | Installs from the allowlist work and everything else is refused; P4's gates still pass. **E12 starts in parallel with 1a** |
| **3 — Hardening**             | `Release` frame (delete frees disk at once); worker-side token re-verification (MI1 S4's grant with a configurable signer); `gen` for immediate revocation; per-host mTLS; a dedicated or second KVM host                                 | Wider internal      | Forged token straight to the worker refused; deleted sandbox unusable at once                                              |

Beyond increment 3, the items in §1's out-of-scope list are candidates, ordered by what the cohort's
measurements (§10.7) show.

**Why this order:**

- 1a proves the one path nobody has run yet: the TLS route, the load balancer's idle cut, and the
  KVM host dialing out. It is cheap to undo.
- 1b lands before anyone outside the team arrives, so the cohort never holds a static token.
- Egress is the next blocker after that, which is why its experiment starts first.

## 12. Alternatives considered

- **A new small `sbx-api` service** that imports the control plane's token and identity modules
  (approach B). It separates more cleanly, but it re-implements device flow, refresh families,
  stores and their wiring, at roughly two to three times the code of a route profile, and it is
  another surface to review. Rejected for SBX0. A route profile can later be split out if the
  products diverge.
- **Sandboxes as MOCA sessions** (approach C): reuse `/v1/sessions`, with the session as the
  sandbox. Almost no new code, but it brings harness semantics along (config bundles, `aud: harness`
  tokens, session quotas), and it makes the relay accept harness-audience tokens. That blurs the
  token separation MI1 depends on. Rejected.
- **Operator-issued static tokens per user.** No login code, but revocation means editing a Secret
  and restarting the relay, and it doesn't grow. Kept only for increment 1a, for the team.
- **Prefix namespaces instead of explicit sandboxes.** Least code, but #338's silent reset stays.
  Rejected.
- **A hosted MCP server** (bearer header, or MCP OAuth 2.1). It needs nothing installed on the
  laptop, but it is a new internet-facing surface that holds user tokens. With `mocactl` already
  needed for push and pull, the local server costs users nothing extra. Deferred.
- **The front door on the KVM host itself, or on a new VM.** That would put users on the host's
  network path, or add a new box to run. The worker's dial-out model makes a cluster namespace the
  cheaper front door. Rejected.
- **Egress as a launch blocker.** It would put an unproven mechanism (E12) on the critical path.
  Rejected in favour of curated templates now and egress next.

## 13. Open questions

- **O1. Template contents.** Which language versions and libraries the cohort needs. Settled with the
  cohort before 1c.
- **O2. The token verifier's home.** _Settled during planning:_ the relay imports it from
  `@moca/control-plane`, as `knative-server` already does for `/turn` (`turn-auth.ts`).
- **O3. Tool-layer extraction depth.** _Settled during planning:_ the tools are reimplemented in
  `@moca/sandbox-client` without Pi (§6.4). A shared tool layer for the harness and SBX0 is later
  work.
- **O4. Concurrent agents on one sandbox.** Claude Code subagents and OpenCode parallel sessions
  queue on one sandbox. Measured during the cohort (§10.7). One fix is a sandbox per agent, which the
  per-user quota already allows.

## 14. Risks

1. **One shared KVM host.** Its maintenance or loss ends every sandbox. Mitigations: the laptop keeps
   the original tree; `doctor` and `ls` warn about work not yet pulled; increment 3 adds a host.
2. **No network** limits which repositories work. Mitigation: curated templates, and egress next
   (increment 2). Its experiment starts with 1a.
3. **Delete is not immediate** (≤ 15 min). This is acceptable for an internal cohort, documented, and
   closed in increment 3.
4. **Re-enabled local tools void isolation.** If a user turns the built-ins back on, the agent edits
   the laptop. Mitigations: merged configuration and `doctor`'s check (§6.3).
5. **The route profile shares code with the harness control plane.** A harness route mounted by
   mistake would expose harness behaviour. Mitigation: per-profile allow lists and the enumerating
   test (§10.1).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
