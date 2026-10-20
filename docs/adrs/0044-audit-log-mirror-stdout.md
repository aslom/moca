# ADR-0044: Mirror audit decisions to component stdout as structured JSON, identifiers-only

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-20
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-20-audit-log-mirror-design.md`](../specs/2026-10-20-audit-log-mirror-design.md)

## Context

MOCA records lifecycle decisions in Redis via the `sh:cp:audit` stream — `session_created`,
`credential_issued`, `bundle_promoted`, `sandbox_created`, `refresh_rotated`, and so on. The stream
is keyed by subject and sessionId and has the information an operator needs for incident response.
It is not surfaced to `kubectl logs`.

Running the `moca_chained_subagents` demo (kagenti-demos) on `edge-12536a6` and tailing
`kubectl logs -f` on every server pod through a full dispatch cycle emits **~zero per-request
lines**: supervisor emits one pool-admission line, control plane / context-service / both sandbox
pods emit nothing per request. The ownership-plane audit lives in Redis; the data plane
(`handleRunLeafParsed`) has no audit helper at all and never records a per-run decision.

Issue #359 ("Attribute every harness/worker log line to its subject and session") separately
requires per-line subject/sessionId attribution on all log output. The two concerns share a fix.

## Decision

Mirror every audit decision to component stdout as **one JSON line per decision**:

- **Control plane.** `auditBestEffort` (`packages/control-plane/src/handler-util.ts`) emits the
  mirror before awaiting the Redis `XADD`, so the line still appears when Redis is down. The three
  raw `index.audit` call sites (`handlers.ts:createSession`, `updateSession`, `deleteSession`),
  `exchange.ts`, and `refresh-redis.ts` get sibling emits. The sandbox routes
  (`sandbox-handlers.ts`) inherit the fix through their local wrapper over `auditBestEffort`.
- **Data plane.** `knative-server/src/server.ts handleRunLeafParsed` (the P6 sync-run path) emits
  `run_started` once before `runLeaf` and `run_finalized` once after — carrying `auth.subject`,
  `body.sessionId`, `body.workloadId`, `kind`, final `status`, and (where applicable) `reason`.
- **Shape.** Flat JSON. `(line: Record<string, unknown>) => void` — deliberately the same signature
  as the supervisor's local `opts.log` (`packages/supervisor/src/main.ts:49`) so a future
  consolidation ADR could unify them trivially.
- **Policy.** Identifiers only. Never prompts, responses, filenames, display names, credential
  values, error-message bodies, PII beyond `subject`. Enforced by three tests
  (`test/audit-log.test.ts` covers no-tokens, no-user-content, field-whitelist) so new audit
  decisions can't drift the invariant.

### Not in this ADR

- Tool-call transcript retrieval (separate upstream request).
- Log levels / filtering / aggregator shipping.
- OTel SDK dependency. The flat JSON shape is ingestible by OTel's Filelog receiver; a future ADR
  could re-key to OTel semconv (`enduser.id`, `moca.session.id`, `severity_text`, `service.name`)
  additively, without renames on the consumer side.
- AsyncLocalStorage / request-scoped context. Not needed — `subject` and `sessionId` are already
  locals at every emit site; concurrent-turn attribution follows from explicit params alone.
- The deprecated Knative/KEDA drain (`leaf-job.ts` + `leaf-job-runner.ts`, ADR-0041, removal no
  earlier than end of Oct 2026). `LeafEnvelope` doesn't carry `subject`; the P6 path is where the
  demo and the current cluster deploy run.

## Consequences

**Gained.**

- `kubectl logs | jq 'select(.event=="audit")'` is now a grep surface for session lifecycle.
- Platform engineers can correlate "what happened to session X" against pod logs without
  cluster-admin Redis access.
- Future OTel adoption is unblocked (not pre-committed).
- #359's attribution test is satisfied by construction — every emit site carries `subject` by
  explicit parameter.

**Accepted.**

- One Redis-write worth of log output per audit decision. At current volumes, well under the
  per-pod log budget.
- The deprecated KEDA path remains silent per request. ADR-0041 removes it in a few weeks;
  investing in its attribution is not worth the envelope-widening cost.
- **Pod stdout retention is governed by the operator's log infrastructure, not by MOCA.** Once
  a line is written to stdout it is subject to the kubelet's container-log rotation and to any
  log aggregator (Elasticsearch, Datadog, Loki, …) the operator has configured — including its
  retention and deletion policies, over which MOCA has no control. `teardown.sh` and
  `mocactl sessions delete` do **not** retract prior audit lines; a `session_deleted` entry is
  appended, not applied retroactively. This is the right policy — audit trails that disappear
  on teardown aren't audit trails — and it is why the identifiers-only data-handling rule
  (see the spec) is strict: emitted lines are effectively permanent.

## Alternatives considered

- **AsyncLocalStorage request context.** Greenfield in this repo (no existing usage). Overkill —
  explicit params already carry subject and sessionId everywhere they are needed.
- **OTel SDK (`@opentelemetry/*`) now.** Bigger scope than #359 asks for. Our flat JSON is
  Filelog-ingestible; a future ADR can commit to OTel semconv additively.
- **pino / winston.** New runtime dependency for the same JSON-per-line shape.
- **Extracting the supervisor's `opts.log` into a shared module.** Scope creep; touches supervisor
  startup and tests. The 5-line duplication in `audit-log.ts` is cheaper and the signature matches.
