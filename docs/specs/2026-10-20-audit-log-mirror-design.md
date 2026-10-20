# Audit log mirror — design

Version: 1.0 — October 20, 2026
Status: Proposed
Decision record: [ADR-0044](../adrs/0044-audit-log-mirror-stdout.md).

Builds on these; reuses them:

- The ownership-plane audit stream `sh:cp:audit` (`packages/control-plane/src/ownership.ts`).
- `auditBestEffort` (`packages/control-plane/src/handler-util.ts`) — the shared control-plane audit
  entry point.
- The supervisor's local structured-log convention (`packages/supervisor/src/main.ts:49`).

## 1. Problem

For a server deployment that already records lifecycle decisions in Redis (`sh:cp:audit`), the
operator-visible side-effect of a dispatched session via `kubectl logs` is **nothing**. Verified on
`edge-12536a6` against the `moca_chained_subagents` demo with every pod tailed through a dispatch
cycle. Incident response has no grep surface short of cluster-admin Redis access.

Issue #359 names the same gap from a different angle: every log line must carry subject and
sessionId. The two concerns share a single fix.

## 2. Design

### 2.1 Shape

One JSON line per audit decision on component stdout. Flat, not nested:

```jsonc
{
  "event": "audit",
  "decision": "session_created",
  "subject": "github:69598118",
  "sessionId": "325e15f3-bc0d-47ff-8131-81d6f299771f",
  "credential": "my-anthropic",
  "model": "claude-sonnet-5"
}
```

The emitter is one function:

```ts
export type AuditLog = (line: Record<string, unknown>) => void;
export const defaultAuditLog: AuditLog = (line) => console.log(JSON.stringify(line));
```

Signature is deliberately identical to `packages/supervisor/src/main.ts:49`'s `opts.log`. A future
ADR that consolidates logging across the repo can merge the two without churn.

### 2.2 Where it emits from

Three seams:

- **Control plane — `auditBestEffort`.** Emits before awaiting the Redis `XADD`. The line still
  appears when Redis is down (matches the existing "loud swallow" ethos). Fan-out to every call
  site that already uses `auditBestEffort`, which includes all the sandbox routes via a local
  wrapper.
- **Control plane — raw `index.audit` sites.** `handlers.ts createSession/updateSession/
  deleteSession`, `exchange.ts`, and the refresh store's `issue`/`rotate`/`revoke`/`revokeFamily`
  paths. Each gets a sibling `log({event:'audit', ...})` call next to its XADD.
- **Data plane — `knative-server/src/server.ts handleRunLeafParsed`.** This is the P6 sync-run
  path. `run_started` emits once before the first `runLeaf` call; the saturation retry loop does
  not re-emit. `run_finalized` emits once with the terminal status.

### 2.3 Attribution

#359's acceptance test is "two concurrent turns for different subjects produce log lines each
attributed to the right subject." Our emit sites already have `subject` and `sessionId` as locals
(that's what `index.audit` receives today). We pass them to the mirror by explicit parameter. No
shared mutable context exists to race, so concurrency is handled by construction. The attribution
test in `test/audit-log.test.ts` locks this behavior down.

**Why not AsyncLocalStorage.** No existing usage in the repo. Introducing it would be greenfield
scope on top of a change that doesn't need it.

## 3. Data-handling policy

The log is for operational correlation only. Shared log aggregators (Elasticsearch, Datadog, Loki)
retain and index every byte we emit. Future customers may run MOCA against regulated data. The
invariant must survive new audit decisions being added later.

### 3.1 Allowed field whitelist (closed set)

| Field | Shape | Example |
|---|---|---|
| `event` | fixed literal | `"audit"` |
| `decision` | enum | `"session_created"`, `"session_deleted"`, `"session_deleted_in_flight"`, `"model_changed"`, `"credential_written"`, `"credential_deleted"`, `"credential_issued"`, `"operator_fallback_used"`, `"config_bundle_uploaded"`, `"config_bundle_unchanged"`, `"config_bundle_refused"`, `"config_bundle_deleted"`, `"sandbox_created"`, `"sandbox_deleted"`, `"refresh_issued"`, `"refresh_rotated"`, `"refresh_reuse_detected"`, `"refresh_refused"`, `"refresh_revoked"`, `"run_started"`, `"run_finalized"` |
| `subject` | OIDC subject id | `"github:69598118"` — identifier only, never display name / email / org |
| `sessionId` | opaque UUID | `"325e15f3-bc0d-47ff-8131-81d6f299771f"` |
| `workloadId` | opaque id | `"wl-39cbbd4b"` |
| `configRef` | sha256 digest | `"sha256:6f7be6…"` — digest only |
| `sandboxId` | opaque id | `"moca-sandbox-0"` |
| `credential` | credential name | `"my-anthropic"` (name, not value) |
| `model` / `fromModel` | model name | `"claude-sonnet-5"` |
| `kind` | enum | `"prompt"` or `"solve"` |
| `status` | enum | `"responded"`, `"failed"`, `"paused"`, `"solved"`, `"done"`, `"aborted"` |
| `reason` | short enum code only | `"saturated"`, `"error"`, `"redis_unavailable"`, `"revoked"`, `"abs_expired"`, `"idle_expired"`, `"reuse"`, `"unknown"`, `"logout"`, `"logout_all"` — **not** error messages, stack traces, or user input |
| `bytes` | integer | `2140` |
| `writable` | boolean | `true` |
| `family` | opaque uuid | `"6fb5d863-…"` (refresh family) |
| `graceReplay` | boolean | `true` (refresh grace-window replay) |
| `leafSid` | opaque id | `"<sid>"` (for data-plane leaf identity) |
| `attempt` | integer | `1` (delivery count on the KEDA path — deferred) |

### 3.2 Explicitly prohibited

Regardless of field name — enforced by the three tests in `test/audit-log.test.ts`:

1. **Credentials / secrets.** No `token`, `secret`, `password`, `apiKey`, `credentialValue`,
   `Authorization` header values, JWT-shaped substrings (`eyJ[A-Za-z0-9_-]{10,}`), refresh token
   values, Anthropic/OpenAI key shapes.
2. **Prompt text.** The leaf's prompt (the operator's question) must never appear — not truncated,
   not hashed. The user asked a specific thing; that content is not ours to log.
3. **Leaf response text.** The subagent's final message, intermediate turns, tool-call outputs,
   file contents it read — none go near a log line. Transcript retrieval is a separate opt-in API
   if it ever exists.
4. **Workload contents.** File names, file contents, directory listings inside a workload. The
   `revision` digest is the handle.
5. **Config bundle contents.** Names of skills in a bundle, their text, directory layout — only
   the digest.
6. **PII beyond `subject`.** No email addresses, display names (even though Redis stores one on
   `sh:cp:refresh:family:<fam>`), org affiliations, IP addresses, device labels.
7. **Error messages verbatim.** Only short enum codes in `reason`. If Redis call fails, emit
   `reason: "redis_unavailable"` — never `reason: "ECONNREFUSED 10.96.176.141:6379"` and never
   the exception stack.

The existing `console.error` loud-swallow in `handler-util.ts:51` is a diagnostic, not an audit
emission; it stays separate and off the audit-log channel.

## 4. Enforcement

Three test invariants in `packages/control-plane/test/audit-log.test.ts`:

- **no-tokens.** Seed a credential with a planted token. Drive every auditing route. For every
  emitted line, assert the token does not appear and no JWT-shaped substring does.
- **no-user-content.** Plant markers in prompt / display name / filename / skill body fields.
  Drive every auditing route. For every emitted line, assert no planted marker appears.
- **field-whitelist.** For every emitted line, every key must be in §3.1's set. New decisions
  that introduce an off-whitelist field fail this test.

Attribution is covered by a fourth test: two concurrent `createSession` calls produce two lines
with the correct `subject` on each.

## 5. OTel compatibility

Flat JSON lines are ingestible by OTel's Filelog receiver out of the box. The current field names
are MOCA-internal; if a later ADR commits to OpenTelemetry semantic conventions, the mapping is
additive — no rename on the consumer side:

- `subject` → `enduser.id` (OTel semconv)
- `sessionId` → `moca.session.id` (domain-specific attribute)
- `workloadId` → `moca.workload.id`
- `configRef` → `moca.config.ref`
- `sandboxId` → `moca.sandbox.id`

An OTel-strict operator today can run the Filelog receiver with a transform that renames those
fields. Adding `severity_text` / `severity_number` / `service.name` later is also additive.

## 6. Non-goals

- **Tool-call transcript retrieval.** The harness has the trace server-side; a client API for it
  is a separate change (worth filing upstream).
- **Log levels / filtering.** Everything is at INFO. One stream, grep is the filter.
- **Aggregator shipping.** Operators can tail/aggregate stdout as they see fit.
- **OTel SDK dependency.** Not required to be Filelog-ingestible.
- **Span / trace correlation (`trace_id`, `span_id`).** Different subsystem; separate ADR.
- **The deprecated KEDA path** (`leaf-job.ts` + `leaf-job-runner.ts`, ADR-0041). `LeafEnvelope`
  doesn't carry `subject` and the path is being removed. Not worth widening the envelope here.

## 7. Verification

- Unit: `cd packages/control-plane && npx vitest run test/audit-log.test.ts` — five invariants in
  one file.
- Unit (P6 path): `cd packages/knative-server && npx vitest run test/run-leaf-audit-log.test.ts`
  — asserts `run_started` once before `runLeaf`, `run_finalized` once after, no re-emit on
  saturation retry.
- E2E: build and deploy to the `moca_chained_subagents` demo cluster, tail `kubectl logs -f` on
  all five server pods through a full dispatch, confirm per-request lines land for the dispatched
  sessionId.
- Secret-leak: grep each pod's logs for the planted token / Anthropic key — must return zero.
