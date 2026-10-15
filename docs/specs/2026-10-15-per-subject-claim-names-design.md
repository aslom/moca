# Per-subject claim names — caller-named PVCs scoped by construction — Design

**Date:** 2026-10-15 · **Status:** Proposed · **Issue:**
[#358](https://github.com/rossoctl/moca/issues/358) — the second half; the first half
(subject-scoped workload names) shipped with #350/#482.
**Builds on (reuse, no redesign):** [MI1](2026-09-28-moca-multi-user-isolation-design.md)
(§4.3 records the stop-gap, §13 the deferral); the `/workloads` lifecycle
(`packages/knative-server/src/workloads.ts`: `recordScope`, `contextNameFor`, `WORKSPACE_FIELDS`);
[context-service](../../context-service.md) (Moca's client for Context Service's trusted,
storage-only API); [mocactl-control-plane-client-design](2026-09-25-mocactl-control-plane-client-design.md)
§7 (`workloads create`/`get`). Everything here is additive or lifts a refusal.

## 1. Problem

`POST /workloads` once forwarded a caller-supplied `workspace.claimName` to Context Service, and
neither the harness nor Context Service checked that the caller may use that PVC: owning a workload
says nothing about owning the volume it names, so a user could run on — and read — another user's
workspace. #350's review closed that hole with a stop-gap: `claimName` is refused outright
(`workspace_field_not_allowed`, since `WORKSPACE_FIELDS = {size, storageClass}`), which removes
bring-your-own-PVC from every multi-user deployment entirely. The anonymous caller of an
unauthenticated deployment lost nothing it still had, but the feature is gone for everyone.

#358 asks for the guard to be replaced by authorization: a caller may name **their own** claim and
nobody else's. The two routes the issue records are a subject→claims mapping held by the control
plane or Context Service, or scoping claim names per subject where they are used. Subject-scoped
workload names — the other half of #358 — are already built: record keys carry
`recordScope(owner)`, and another user's workload is indistinguishable from a missing one.

### Acceptance

1. An authenticated caller can create a workload over a claim they name (`workspace.claimName`),
   and that workload runs on that claim's volume — bring-your-own-PVC works under
   `MOCA_TENANCY=multi`.
2. A caller cannot cause Context Service to receive a claim outside their own scope, whatever they
   send: Alice naming `data` never produces Bob's claim name — not by a check that could be
   incomplete, but by construction.
3. The caller learns the exact claim name to pre-create (it is theirs, so revealing it to them is
   safe) and nobody else's.
4. The stop-gap refusal is gone; `workspace_field_not_allowed` still guards every field this design
   does not add.

## 2. Design — derive the claim name from the owner

**Authorization by construction, not by lookup.** The caller names a claim the way they name a
workload — a short lowercase slug — and Moca derives what Context Service actually receives:

```
moca-<scope>-<claim>     where <scope> = recordScope(owner) = sha256(owner)[:32]
```

- The caller-supplied part is validated exactly like a workload name: the existing `NAME` regex,
  at most 50 characters, `400 claim_name_invalid` otherwise. `WORKSPACE_FIELDS` gains `claimName`.
- The scope is the same stable per-owner hash that keys the Redis records (`recordScope`,
  `workloads.ts:75`). It must be stable, unlike `contextNameFor`'s per-reservation hash, because a
  pre-created PVC is reused across workloads and re-creations of the same name.
- The derived name is at most 88 characters (`moca-` + 32 hex + `-` + 50), well inside DNS-1123's
  253, and matches its alphabet by construction.
- A caller can only ever produce names inside their own scope, so requirement 2 holds with nothing
  to enforce elsewhere: no mapping store, no admin surface, no change to Context Service, no
  cross-repo coordination. Moca remains the trusted tier for storage attachment (it already names
  the user in `X-Context-Subject` and derives Context names); this extends the same trust, it does
  not add a new reliance.

**Where the derived name goes.** `ContextStorage` (`context-service.ts`) gains
`claimName?: string`; `createContext` already spreads storage into
`{ backend: 'pvc', accessMode: 'ReadWriteOnce', ...storage }`, so the derived name flows to Context
Service unchanged. The derived name — not the caller's slug — is stored on the `WorkloadRecord`
(`workspace.claimName`), so `publicView` returns it in `GET /workloads/{id}`, the `201` from create,
and `mocactl workloads get`: requirement 3. It is the owner's own scope, so returning it to them is
safe, and no other caller's view ever includes it.

**Validation neighbours.** `size` and `storageClass` keep their current validation and are
forwarded as before; whether they matter alongside an existing claim is Context Service's contract,
unchanged here. The anonymous caller of an unauthenticated deployment gets a stable scope like any
subject, so bring-your-own-PVC returns there with no special case — the stop-gap's one carve-out is
subsumed rather than restored.

**mocactl.** `workloads create --claim <name>` passes `workspace.claimName` through; `get` shows
the derived name in the workspace view (the JSON view already carries `workspace`).

## 3. What is deliberately not built

- **A subject→claims mapping** (the issue's first route). An allowlist accepts arbitrary
  pre-existing PVC names, but needs an admin API to manage it, storage, and its own tests — real
  scope — to buy only a friendlier name. Rejected; the derived name is one `mocactl get` away.
- **Context-Service-side enforcement.** Context Service already receives `X-Context-Subject` and
  could refuse out-of-scope claims, but that change lives in `rossoctl/context-service` and leaves
  Moca's contract unguarded on its own. Not needed: derivation makes the guard local and total.
- **Reverse listing** (which subject owns a claim) and **claim-name changes** after create. The
  first has no consumer; the second never existed.

### Limits, stated honestly

- The derived name is opaque. Whoever pre-creates the PVC — an operator, or a user with namespace
  access — must obtain it from the owner's `GET /workloads/{id}`. That is the price of the mapping
  not existing.
- A caller with rights to create PVCs in the Context Service namespace could plant a PVC under
  another subject's derived scope. Such a caller is already operator-privileged there (they can
  mount any claim directly); no boundary this design draws is crossed by them.
- Whether Context Service requires the named claim to exist at create time, or fails later at
  binding, is its contract; a missing claim surfaces through the existing error paths
  (`context_service_error` or its 409 passthrough).

## 4. Testing

- `packages/knative-server/test/workloads.test.ts`: `claimName` validation (`claim_name_invalid`);
  create with a claim → the recorded Context Service call carries
  `storage.claimName = moca-<sha256(owner)[:32]>-<claim>`; the same slug from two owners derives to
  two different names (Alice cannot name Bob's claim — by construction); the `201`/`GET` view
  returns the derived name to its owner; `workspace_field_not_allowed` still refuses unlisted
  fields; the stop-gap case (`claimName` → `workspace_field_not_allowed`) is replaced.
- `packages/mocactl/test/workloads.test.ts`: `--claim` passthrough on create; the derived name in
  the `get` view.

## 5. Records

Closes MI1 §13's "per-subject PVC authorization" bullet (the issue's other half, subject-scoped
workload names, was already closed with it). The MI1 §4.3 paragraph keeps its historical account of
the stop-gap; §13's bullet records the closure in place, per that spec's amendment convention.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
