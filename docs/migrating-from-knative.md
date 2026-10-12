# Migrating off the Knative/KEDA deployment

> **Deprecated 2026-10-11.** The Knative + KEDA deployment path — the Knative Service, KEDA
> ScaledJobs, `KubectlTransport` and pod-exec sandboxes under `deploy/knative/` — is deprecated
> ([ADR-0041](adrs/0041-deprecate-knative-keda-deployment.md)). P6, the process-manager runtime,
> is the primary way to run MOCA sessions. During the window the old path receives security and
> breakage fixes only, and no new features. Removal comes no earlier than **end of October
> 2026**, and only once its remaining users have migrated — if that is you, say so in a
> [GitHub discussion](https://github.com/rossoctl/moca/discussions) so the date can account for
> you.

## What is deprecated — and what is not

Deprecated, per [ADR-0037](adrs/0037-p6-on-kubernetes-substrate.md)'s scope — a deployment model,
not a substrate:

- the Knative Service and its revision/activator machinery (`deploy/knative/service.yaml`,
  `setup-kind.sh`, `setup-ocp.sh`);
- KEDA ScaledJobs (`deploy/knative/leaf-scaledjob.yaml`) and the `leaf-job.ts` entrypoint that
  drains them;
- `KubectlTransport` and pod-exec sandboxes — the K8s-specific half of `packages/k8s-sandbox`;
- the manifests, overlays, smoke scripts and OCP image build under `deploy/knative/`.

**Not** deprecated:

- **Kubernetes as a substrate.** [`deploy/k8s/`](../deploy/k8s/README.md) runs the P6 process model
  as ordinary Kubernetes workloads and is maintained as a first-class deployment (ADR-0037). If
  you want to stay on a cluster, that is your destination, not a compromise.
- **Containers as a sandbox technology.** The container sandbox tier (`remote-worker/cmd/worker`)
  is substrate-agnostic and stays; the per-`Exec` microVM tier
  ([ADR-0035](adrs/0035-per-exec-microvm-warm-standby.md)) is its stronger sibling.
- **The shared harness code.** `packages/knative-server`'s name is historical — its `worker.ts` is
  the process the P6 supervisor forks, and the non-K8s half of `packages/k8s-sandbox` carries the
  transport P6 runs on. The packages stay; only their K8s-specific halves are deprecated.

## Pick a destination

| You want...                                        | Go to                                            | Notes                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| To stay on Kubernetes or OpenShift                 | [`deploy/k8s/`](../deploy/k8s/README.md)         | P6 on Kubernetes (P6.1, epic #426). Namespaces and NetworkPolicy replace podman isolation — a NetworkPolicy-enforcing CNI is a hard requirement. Kind and OCP overlays ship (`setup.sh`). |
| A dedicated VM or bare metal — the production path | [`deploy/vm/`](../deploy/vm/README.md)           | `setup-vm.sh`, systemd units, podman `isolate=strict` + nftables. Carries the hardening, reboot handling and E8 run discipline.                                                           |
| To try P6 in five minutes, no root                 | [`deploy/compose/`](../deploy/compose/README.md) | The trial path — the supervisor, relay, Redis and a sandbox under Docker Compose, optionally with the MU1 control plane. Same processes, same wire; not for production.                   |

All three run the same processes, the same environment and the same wire. Only the process
manager, the addressing and the way isolation is enforced differ.

## What maps to what

| Knative path                                                       | P6 path                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knative Service: scale-to-zero HTTP endpoint, activator cold-start | Supervisor: L4-only ingress, socket hand-off to a fixed worker pool ([ADR-0034](adrs/0034-vm-process-manager-socket-handoff.md)). Workers are warm — there is no cold-start term in the ceiling.                                                                                                                            |
| KEDA ScaledJob: `leaf-worker` pods 0→N on queue depth              | Supervisor-managed workers: many sessions per worker, a bounded number of concurrent in-flight turns each, admission control instead of autoscaling.                                                                                                                                                                        |
| Pod-exec sandboxes via `kubectl` (`KubectlTransport`)              | `remote-worker` sandboxes — container tier, or per-`Exec` microVM tier ([ADR-0035](adrs/0035-per-exec-microvm-warm-standby.md)) — dialed in over the gRPC relay. The sandbox dials out; it needs no inbound route.                                                                                                          |
| Kourier / Route ingress                                            | L4 only. Any L7 hop that pools upstream connections silently defeats the supervisor's per-connection hand-off (ADR-0037 §3). On OpenShift, TLS terminates in a sidecar behind a passthrough Route.                                                                                                                          |
| Scale-to-zero between turns                                        | Warm process-manager pods. Idle capacity costs memory continuously; in exchange there is no activator cold-start and no Knative/KEDA operators to run or upgrade.                                                                                                                                                           |
| `async: true` leaf fan-out, drained by KEDA `leaf-worker` pods     | **No P6 equivalent yet.** The P6 runtime serves turns; async leaf dispatch and the CronJob scheduled on-ramp are owed follow-ups (flagged in [ADR-0034](adrs/0034-vm-process-manager-socket-handoff.md) and still open). If you depend on them, say so in the migration discussion — it changes your earliest removal date. |

## Scaling the P6 runtime

The scaling model replaces autoscaling with two levers:

- **Horizontal — add process-manager pods.** Sessions are Redis-backed, so any supervisor can
  serve any session, subject to sandbox affinity: P6.3 keeps a session on the sandbox that served
  its previous turn, waiting out a grace period before a recorded in-tier fallback. Add PM pods
  the way you would add replicas.
- **Vertical — size process-manager pods up.** More workers per supervisor, more memory. The
  supervisor hands accepted sockets to workers and never touches a response byte (ADR-0034), so
  its own ceiling is admission and hand-off, not payload throughput; the density number belongs to
  the worker pool.

What you lose: scale-to-zero. What you gain: no Knative or KEDA operators, no activator cold-start
term in the latency ceiling (E9 measured what the deployment tier was costing), and warm sessions
between turns.

## What carries over

- **Session transcripts.** Both paths persist sessions through `@moca/session-backend` in Redis
  with the same schema. Point the P6 deployment at the same Redis and sessions resume —
  rehydration is a constant ~6 entries / ~900 bytes per session regardless of length (E2).
- **Credentials and promoted config bundles.** Owned by the MU1 control plane, which runs on both
  paths. On Kubernetes it keeps using `K8sSecretStore` — that is the substrate, not the deprecated
  path; off Kubernetes it uses the non-K8s `CredentialStore` (#348).
- **What does not carry: sandbox filesystems.** Pod-exec sandboxes and P6 sandboxes are different
  instances. After cutover a session's next turn re-derives its workspace — the tree is a detached
  worktree at a pinned commit and continuity lives in the Redis session log, so this costs a
  fetch, not data.

## Bring-up

1. Pick a destination above and follow its README end to end (`deploy/vm/setup-vm.sh`,
   `deploy/k8s/setup.sh`, or `deploy/compose/install.sh`). Bring the P6 side up in parallel with
   the running Knative deployment — they share nothing but Redis.
2. Point the P6 deployment at the same Redis instance, or replicate Redis first.
3. Repoint clients at the P6 deployment's endpoints — the control plane for authentication and
   session management, the supervisor listener for turns. Each destination README documents its
   supported topology (for `deploy/vm`, see "Reaching it: the supported demo topology").
4. Verify with a canary session that resumes a pre-migration transcript, then decommission the
   Knative Service, the KEDA ScaledJobs and their RBAC.

## During the window

- The deprecated path keeps working and receives security and breakage fixes. It gets no new
  features.
- If you run the control plane on the deprecated K8s path during the window, #248's
  namespace-collocation consideration still applies to it, unchanged by the deprecation.
- Removal happens no earlier than end of October 2026 and only once the remaining users have
  migrated. [Tell us when you have moved](https://github.com/rossoctl/moca/discussions) — the
  condition is users, not the calendar alone.
