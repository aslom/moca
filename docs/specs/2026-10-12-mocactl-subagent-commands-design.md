# `mocactl` subagent commands — spawn, subagents, get

Status: Proposed — 2026-10-12
Issue: [#381](https://github.com/rossoctl/moca/issues/381)

## 1. Problem

`mocactl` today only drives `/v1/turn` — a prompt, streamed, foreground, one session at a
time. A workflow where a parent agent fires off work, exits, and another `mocactl`
invocation later collects the result has no client surface, so demo and scripting work
that needs that shape has to go through its own one-off wrappers.

The server side has what we need: the sync `POST /v1/runs` + `GET /v1/runs/status` leaf
endpoints
([`2026-06-26-mvp-leaf-session-contract-design.md`](2026-06-26-mvp-leaf-session-contract-design.md)),
with `/v1/runs` applying a `configRef` carried on the request envelope through the
resolve-and-overlay path
([`2026-10-06-mocactl-config-bundle-promotion-design.md`](2026-10-06-mocactl-config-bundle-promotion-design.md)).
`/v1/runs` reads `configRef` from the request body, so a client that wants its leaves to
run under a promoted bundle must send `configRef` on every leaf envelope. What is missing
is a client that can build that envelope, fire the leaf, survive its own exit, and later
re-join the result from another invocation.

## 2. Decision — three commands, one transport, one ledger

### 2.1 `mocactl spawn` — fork a detached leaf-turn worker

```
mocactl spawn "prompt" [--config sha256:…] --kind prompt|solve \
  [--repo URL --ref REF] [--tag T] [--json]
```

Creates a session (pinned to the bundle at `--config`, following the same `--config`
vocabulary `mocactl run` already uses), writes a `record` line to the ledger (§2.5), then
forks a detached worker (§2.6) that holds the sync `POST /v1/runs` call outside this
process group. The envelope the worker sends carries `configRef` so the leaf runs under
the promoted bundle (§1). The sessionId is printed on stdout immediately so a script can
capture it; quitting `mocactl` does not kill the worker.

`--kind solve` requires `--repo URL` and `--ref REF`; `--kind prompt` refuses them. The
prompt text becomes `env.prompt` on a prompt envelope and `env.problemStatement` on a
solve envelope (the harness builds the agent's prompt itself for solve). `--tag T`
groups related spawns so `subagents --tag T` can list a single parent agent's children
in isolation. The prompt is capped at 64 KiB so a ledger `record` line stays small enough
to fit one `write(2)` on a local filesystem (§2.5).

### 2.2 `mocactl subagents` — join ledger with `/v1/runs/status`

```
mocactl subagents [--tag T] [--json]
```

Reads the ledger and joins each row with `/v1/runs/status`, resolving the server's
three-way `queued` (still running / never recorded / aged out) with child-pid liveness
and a 60-second grace window (§2.7). Terminal rows are not re-queried — see §2.5 for
why that matters at 24 hours. Oldest-first by dispatch time.

### 2.3 `mocactl get SESSIONID` — write terminal result files

```
mocactl get SESSIONID [--out DIR] [--json]
```

Fetches a terminal result and writes `<sid>.text` (prompt), `<sid>.patch` (solve, trailing
newline normalized so `git apply` does not reject it), and `<sid>.verdict.json` if the
server returned a verdict. Exit `0` only for `responded` / `done` / `solved`; `paused` is
terminal but a gate decision is still pending, so it exits `1`. On a `failed` body, exits
`1` with the status, reason, and detail message echoed to stderr (all sanitized through
the same table-rendering filter the listing uses, since every string comes from the
server).

### 2.4 Leaf-turn transport

A single module (`packages/mocactl/src/transport/leaf-turn.ts`) owns the `POST /v1/runs`
and `GET /v1/runs/status` wire shapes and the honest-state mapping. The three commands
depend on this module, not on `fetch` directly, so a later async-turn transport
([`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md))
can replace the backend without touching the commands.

### 2.5 Subagent ledger

`$XDG_STATE_HOME/mocactl/subagents.jsonl`, mode 0600. Append-only JSONL with two line
types folded by sessionId on read:

- `record` — written once per spawn, carries the full dispatch envelope so a future
  `approve`/`reject` can resend with a gate decision.
- `update` — written on every state change, carries just the delta.

Each append is a single `O_APPEND` `write(2)` on a local filesystem, which the kernel
commits as one non-interleaving unit so concurrent writers do not clobber each other
without an explicit lock. The 64 KiB prompt cap in §2.1 keeps a `record` line short
enough that the OS commits it in one syscall.

The ledger is authoritative past a terminal state. `/v1/runs/status` has a 24-hour TTL
on the harness side, so a `subagents` call a day after a run would otherwise regress a
durable `done` row to `unknown`. §2.2 skips the re-query for terminal rows for exactly
this reason.

File creation and append use `openSync` with `O_CREAT | O_NOFOLLOW` and the 0600 mode
passed to the syscall itself, so the mode is set atomically on create and a symlinked
state file is refused at open time.

### 2.6 Detached-child mechanism

`child_process.spawn` with `detached: true` + `unref()`, re-execing the same
`mocactl.mjs` into a hidden `__spawn-worker` subcommand. The session token is passed on
stdin so it stays out of argv and env. The parent also forwards the resolved
control-plane and harness URLs on stdin so the worker can rebuild its runtime from a
single source. The worker's stdout/stderr go to
`$XDG_STATE_HOME/mocactl/spawn-<sid>.log`. Fork completion is awaited on the child's
`'spawn'` / `'error'` events before the parent returns, so an async failure (ENOENT,
EACCES after `spawn()` returned) marks the ledger row `failed`, closes the log fd, and
surfaces to the caller instead of being reported as a successful spawn.

Every worker exit that has a sessionId writes a ledger update. On a terminal body
(`responded`/`done`/`solved`/`paused`/`failed`/`aborted`) the row becomes terminal with
the matching honest state. On a sync 503 `{status:'failed', reason:'saturated'}` the
server treats saturation as a retryable transient (`run-leaf.ts`: _"a 503 is 'retry',
not a terminal failure, and `/v1/runs/status` must not report it as one"_); the worker
rewrites the row as `running` with `stateDetail: 'saturated — retry'` and a fresh
`stateObservedAt`, so the 60-second grace restarts from exit. The one exit without a
ledger write is a malformed-stdin failure (no sessionId yet); the parent's `record` row
stays authoritative and `subagents` drives it from `/v1/runs/status` on the next call.

### 2.7 Honest states

Surfaced to users as `running | done | paused | failed | unknown`. The mapping from
(server body, child liveness, grace) to honest state lives in `transport/leaf-turn.ts`:

| Server                      | Child alive | Within grace | Honest state |
| --------------------------- | ----------- | ------------ | ------------ |
| `queued`                    | yes         | —            | `running`    |
| `queued`                    | no          | yes          | `running`    |
| `queued`                    | no          | no           | `unknown`    |
| `responded`/`done`/`solved` | —           | —            | `done`       |
| `paused`                    | —           | —            | `paused`     |
| `failed`                    | —           | —            | `failed`     |
| `aborted`                   | —           | —            | `failed`     |

Grace defaults to 60 s and covers a just-exited child's result-write race. The
within-grace `running` row carries a `child exited; waiting for result` detail string so
the TUI column shows the distinction. `/v1/runs/status` returns `200 {status: 'queued'}`
for a missing record, which the `queued` rows above handle.

## 3. Error handling

- `createSession` failure: no ledger row written, exit `1`.
- Fork failure after `createSession` (synchronous throw or async `'error'` event): the
  ledger row is marked `failed` with the fork error as `stateDetail`, exit `1`. (The row
  still exists so a later `subagents` call shows the failed spawn.)
- Worker-side missing-harness exit: the worker writes a terminal `failed` ledger update
  with the reason on `stateDetail`.
- Worker-side bad-stdin exit: no sessionId to anchor an update, so the worker returns `2`
  without touching the ledger; the parent's `record` row stays authoritative and
  `subagents` drives it from `/v1/runs/status` on the next call.
- Sync 503 `saturated` on `POST /v1/runs`: the worker rewrites the row as `running` with
  `stateDetail: 'saturated — retry'` and a fresh `stateObservedAt`, so the 60s grace
  restarts from exit and the state surfaces as a retry hint instead of ageing to `unknown`.
- Per-row `/v1/runs/status` failure in `subagents`: that row is reported as `unknown`
  with the error as its detail; other rows still render.
- `spawn` validation: bundle digest must match `sha256:<64 lowercase hex>`;
  `--kind solve` must have both `--repo` and `--ref`; `--kind prompt` must have neither;
  prompt must be non-empty and under 64 KiB.
- `get` validation: sessionId must match the harness-side alphabet
  (`[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`); unmet exits `2`.

## 4. Alternatives considered

- **SQLite ledger.** Rejected: adds a native dep, and the append-only JSONL atomicity
  model (one `O_APPEND` `write(2)` per line) is simpler to reason about on paper.
- **Parent process stays attached.** Rejected: the parent must be able to exit without
  killing its children, which is the whole point of the detached-worker shape.
- **Token via env or argv.** Rejected: argv leaks via `ps`; env leaks via
  `/proc/<pid>/environ`.
- **Trust `/v1/runs/status` alone for state.** Rejected: §2.5 — a 24-hour TTL would
  silently regress `done` rows.
- **`--kind converge`.** The server's converge path takes a scanned `item`
  (file/pattern) and returns a verdict, with the agent prompt built from the item itself.
  This slice ships `prompt` and `solve`, which are the two kinds a user supplies with a
  single string of text; `converge` lands with a command that supplies the item.

## 5. Scope — explicitly not building

- `watch`, `approve`/`reject`, `follow-up` commands.
- Client-side concurrency cap on fan-out.
- `--workload <id>` for workload-context lane; this only carries `--config` (config
  bundles).
- A `converge` kind (see §4).
- Automatic ledger compaction. `compact` exists as a `tmp` + `rename` method on the
  ledger, but has no trigger; adding one needs real-world size data.
- Pid-reuse-safe liveness. `subagents` probes with `kill(pid, 0)`, which can read as
  alive if the OS has recycled a dead worker's pid. A pid+start-time pair, or a
  harness-side deadline on the status response, is the follow-up.
