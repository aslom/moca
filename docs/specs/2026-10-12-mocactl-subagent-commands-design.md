# `mocactl` subagent commands — spawn, subagents, get

Status: Proposed — 2026-10-12
Issue: [#381](https://github.com/rossoctl/moca/issues/381)

## 1. Problem

`mocactl` today only drives `/v1/turn` — a prompt, streamed, foreground, one session at a
time. A workflow where a parent agent fires off work, exits, and another `mocactl`
invocation later collects the result has no client surface, so demo and scripting work
that needs that shape has to go through its own one-off wrappers.

The server side is already in place: session-bound `configRef` and the resolve-and-overlay
path on `/runs`
([`2026-10-06-mocactl-config-bundle-promotion-design.md`](2026-10-06-mocactl-config-bundle-promotion-design.md)),
and the sync `POST /runs` + `GET /runs/status` leaf endpoints
([`2026-06-26-mvp-leaf-session-contract-design.md`](2026-06-26-mvp-leaf-session-contract-design.md)).
What is missing is a client that can fire a leaf, survive its own exit, and later re-join
the result from another invocation.

## 2. Decision — three commands, one transport, one ledger

### 2.1 `mocactl spawn` — fork a detached leaf-turn worker

```
mocactl spawn "prompt" --bundle sha256:… --kind prompt|converge \
  [--repo URL --ref REF] [--tag T] [--json]
```

Creates a session (pinned to `--bundle` as in the config-bundle promotion spec §2.4),
writes a `record` line to the ledger (§2.5), then forks a detached worker (§2.6) that
holds the sync `POST /runs` call outside this process group. The sessionId is printed on
stdout immediately so a script can capture it; quitting `mocactl` does not kill the
worker.

`--kind converge` requires `--repo URL` and `--ref REF`; `--kind prompt` refuses them.
`--tag T` groups related spawns so `subagents --tag T` can list a single parent agent's
children in isolation. The prompt is capped at 64 KiB so a ledger `record` line stays
under POSIX `PIPE_BUF` (§2.5).

### 2.2 `mocactl subagents` — join ledger with `/runs/status`

```
mocactl subagents [--tag T] [--json]
```

Reads the ledger and joins each row with `/runs/status`, resolving the server's three-way
`queued` (still running / never recorded / aged out) with child-pid liveness and a
60-second grace window (§2.7). Terminal rows are not re-queried — see §2.5 for why that
matters at 24 hours. Oldest-first by dispatch time.

### 2.3 `mocactl get SESSIONID` — write terminal result files

```
mocactl get SESSIONID [--out DIR] [--json]
```

Fetches a terminal result and writes `<sid>.text` (prompt), `<sid>.verdict.json`
(converge), or `<sid>.patch` (solve) to `--out DIR`. Patches get a trailing newline
normalized so `git apply` does not reject them. Exit `0` only for `responded` / `done` /
`solved`; `paused` is terminal but a gate decision is still pending, so it exits `1`.

### 2.4 Leaf-turn transport

A single module (`packages/mocactl/src/transport/leaf-turn.ts`) owns the `POST /runs` +
`GET /runs/status` wire shapes and the honest-state mapping. The three commands depend on
this module, not on `fetch` directly, so a later async-turn transport
([`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md))
can replace the backend without touching the commands.

### 2.5 Subagent ledger

`$XDG_STATE_HOME/mocactl/subagents.jsonl`, mode 0600. Append-only JSONL with two line
types folded by sessionId on read:

- `record` — written once per spawn, carries the full dispatch envelope so a future
  `approve`/`reject` can resend with a gate decision.
- `update` — written on every state change, carries just the delta.

Each append is a single `write(2)` under POSIX `PIPE_BUF` (4 KiB), which is what makes
concurrent appends atomic without an explicit lock. The 64 KiB prompt cap in §2.1 keeps a
`record` line under that boundary with the envelope and bundle digest attached.

The ledger is authoritative past a terminal state. `/runs/status` has a 24-hour TTL on
the harness side, so a `subagents` call a day after a run would otherwise regress a
durable `done` row to `unknown`. §2.2 skips the re-query for terminal rows for exactly
this reason.

File creation and append use `openSync` with `O_CREAT | O_NOFOLLOW` and the 0600 mode
passed to the syscall itself — no `existsSync`-then-chmod pair, so there is no TOCTOU
window a symlink could race through.

### 2.6 Detached-child mechanism

`child_process.spawn` with `detached: true` + `unref()`, re-execing the same
`mocactl.mjs` into a hidden `__spawn-worker` subcommand. The session token is passed on
stdin, not argv or env, so it never appears in `ps` or `/proc/<pid>/environ`. The
worker's stdout/stderr go to `$XDG_STATE_HOME/mocactl/spawn-<sid>.log` (fd closed on fork
failure, so a thrown `spawn` does not leak the descriptor).

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
| 404 / not_found             | —           | —            | `unknown`    |

Grace defaults to 60 s and covers a just-exited child's result-write race. The
within-grace `running` row carries a `child exited; waiting for result` detail string so
the TUI column shows the distinction.

## 3. Error handling

- `createSession` failure: no ledger row written, exit `1`.
- Fork failure after `createSession`: the ledger row is marked `failed` with the fork
  error as `stateDetail`, exit `1`. (The row still exists so a later `subagents` call
  shows the failed spawn.)
- Per-row `/runs/status` failure in `subagents`: that row is reported as `unknown` with
  the error as its detail; other rows still render.
- `spawn` validation: bundle digest must match `sha256:<64 lowercase hex>`; `--kind
converge` must have both `--repo` and `--ref`; `--kind prompt` must have neither;
  prompt must be non-empty and under 64 KiB.
- `get` validation: sessionId must match the harness-side alphabet
  (`[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`); unmet exits `2`. A 404 from `/runs/status`
  exits `1` with a hint.

## 4. Alternatives considered

- **SQLite ledger.** Rejected: adds a native dep, and the atomicity model (two-line fold
  under `PIPE_BUF`) is simpler to reason about on paper.
- **Parent process stays attached.** Rejected: the parent must be able to exit without
  killing its children, which is the whole point of the detached-worker shape.
- **Token via env or argv.** Rejected: argv leaks via `ps`; env leaks via
  `/proc/<pid>/environ`.
- **Trust `/runs/status` alone for state.** Rejected: §2.5 — a 24-hour TTL would silently
  regress `done` rows.

## 5. Scope — explicitly not building

- `watch`, `approve`/`reject`, `follow-up` commands.
- Client-side concurrency cap on fan-out.
- `--workload <id>` for workload-context lane; this only carries `--bundle` (config bundles).
- Automatic ledger compaction. `compact` exists as a `tmp` + `rename` method on the
  ledger, but has no trigger; adding one needs real-world size data.
