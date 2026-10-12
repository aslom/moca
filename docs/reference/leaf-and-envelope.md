# Leaf envelope and result

> **Preview.** Describes `POST /v1/runs` on `main` as of 2026-10-12 (`harness/src/run-leaf.ts`). A
> **leaf** is one unit of agent work an orchestrator dispatches ([glossary](../glossary.md#leaf)). This
> page replaces the file-based "volume envelope" of the early specs, which no longer exists in the code.

## What changed from the volume envelope

The first leaf contract passed inputs and results as files on a shared volume (`inputsRef`,
`resultRef`, `doneMarkerRef`, `gateRef`, `decisionRef`, a `/work` PVC). The FS-free redesign
([P1 spec](../specs/2026-07-02-p1-fs-free-harness-design.md), ADR-0020) replaced it: inputs and the
gate decision are **inline** in the request, the result is the **response body**, and a copy is stored
in Redis for polling. The harness does no filesystem I/O of its own.

An envelope with the old fields is rejected with 400 `envelope_invalid`. Some scripts under
`deploy/knative/` (`leaf-cron.yaml`, `leaf-gate-smoke.sh`) still use them; they belong to the deprecated
path. A leaf's tools still run in a sandbox with its own filesystem, and `workspaceRef` is a path inside
that sandbox.

## Request

`POST /v1/runs` with a JSON envelope of one of three kinds, chosen by `kind`:

| Kind                                  | Required fields                                   | Behavior                                                                                     |
| ------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Verdict (`kind` absent or `converge`) | `sessionId`, `item`                               | Produces a structured verdict with a `submit_verdict` tool; resumable; supports a human gate |
| `solve`                               | `sessionId`, `problemStatement`, `repoUrl`, `ref` | Works a problem in a fresh per-session workspace and returns a patch. Needs a sandbox pool   |
| `prompt`                              | `sessionId`, `prompt`                             | Leases a sandbox and runs the prompt as a turn on the session                                |

`item` is `{item_id: string, file: string, pattern: string, require_approval?: boolean}`.

Optional fields on any envelope: `decision`, `model`, `provider`, `workspaceRef`, `repoUrl`, `ref`,
`maxTurns` (verdict leaf only), `async`, `tenant`, `configRef`, `problemStatement`, `prompt`, `env_key`.
`configRef` is `sha256:` plus 64 hex characters naming a [config bundle](../guides/promote-claude-workflow.md);
a blank or non-string value is 400 `configRef_invalid`. `workloadId` returns 501
`workload_runs_unavailable`.

`sessionId` is mapped to a safe internal id: a `tenant/` prefix if any, every character outside
`[A-Za-z0-9._-]` becomes `-`, and leading and trailing non-alphanumerics are trimmed.

## Result

The 200 body is a `LeafResult`:

| `status`    | Other fields                                                                                |
| ----------- | ------------------------------------------------------------------------------------------- |
| `done`      | `verdict: {item_id, verdict: "FLAGGED" or "CLEAR", reason}`                                 |
| `paused`    | `gateId` (number), `gate: {summary, proposed_action}`                                       |
| `aborted`   |                                                                                             |
| `solved`    | `patch`, `usage?`                                                                           |
| `responded` | `text`, `usage?`                                                                            |
| `failed`    | `reason`: `no_verdict`, `invalid_verdict`, `bad_inputs`, `error` or `saturated`; `message?` |

A `failed` result is returned as HTTP 200 on the sync path, not as a 4xx or 5xx, except `saturated`,
which becomes 503 with `Retry-After`. Every non-saturated outcome is stored at `leaf:result:<id>` with
a TTL of `LEAF_RESULT_TTL_SECONDS` (default 86400) and is readable with `GET /runs/status?sessionId=`;
the last write wins.

## Idempotency and resume

- **Verdict leaf:** resumable. If a session exists, it is reopened from its checkpoint; if a verdict was
  already recorded it is returned without running the agent or leasing a sandbox. To retry, re-invoke
  the same `sessionId`.
- **Prompt leaf:** there is no fast path; re-invoking runs the prompt again as a new turn on the
  existing session.
- **Solve leaf:** reopens an existing session but re-prompts; the workspace is created fresh and cleaned
  up afterwards.

## The human gate

A verdict leaf whose `item.require_approval` is `true` is told to call `request_approval` once and stop.
`submit_verdict` is withheld until a decision exists. The run then returns
`{status: "paused", gateId, gate: {summary, proposed_action}}` (also stored, and readable from
`/runs/status`). There is no `awaiting_approval` status in the current code.

To resolve it, re-POST the **same envelope** to `/v1/runs` with an inline decision:

```json
{
  "sessionId": "run-1/item-1",
  "item": { "item_id": "a", "file": "x.py", "pattern": "p", "require_approval": true },
  "decision": { "gateId": 0, "action": "approve", "feedback": "ok" }
}
```

| Field      | Notes                                                      |
| ---------- | ---------------------------------------------------------- |
| `gateId`   | Non-negative integer, 0-based; must match the pending gate |
| `action`   | `approve`, `reject` or `abort`                             |
| `feedback` | Optional string                                            |

- A decision that is invalid is ignored, and the run stays paused. A decision for the wrong `gateId`
  also leaves it paused; repeating an already-recorded decision appends nothing.
- `abort` returns `{status: "aborted"}`. `approve` or `reject` continues the agent with a prompt that
  carries the decision.
- There is no harness-side timeout while paused; the result record's TTL is the only bound.
- Gates exist only on the verdict leaf, not on solve or prompt leaves and not on `/turn`.

## Async and scheduled dispatch

`async: true` and the cron on-ramp exist only on the deprecated Knative/KEDA path. On P6, `async: true`
with a token returns 501 `async_runs_unavailable`. See
[the migration guide](../migrating-from-knative.md#if-you-depend-on-async-fan-out-or-the-cronjob).

## Spec drift

- The [human-gate design](../specs/2026-06-28-human-gate-design.md) still describes the file-based
  design (`decisionRef`, `gateRef`, an `awaiting_approval` marker). This page follows the code.
- The P1 spec lists failure reasons without `saturated`, and statuses without `solved` and `responded`.
- Which session id a prompt leaf passes to its turn (the raw or the sanitized one) should be checked
  against `harness/src/run-leaf.ts` before relying on it.
