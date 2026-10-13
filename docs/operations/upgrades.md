# Upgrades

> **Preview.** For P6 on Kubernetes ([`deploy/k8s`](../../deploy/k8s/README.md)). The repository documents no
> rollback procedure; what is below is what the scripts and manifests do.

## Re-running `setup.sh` is the upgrade

`deploy/k8s/setup.sh` is idempotent. It never rotates a secret, and with nothing changed no pod restarts. A re-run
reads the stored inputs, applies the whole kustomization in one `kubectl apply -k`, then waits for each component
in order: Redis, relay, supervisor, control plane (only if a GitHub client id is set), sandboxes. There is no
per-component ordering inside the apply itself.

Inputs are **sticky**: a variable you leave unset keeps its stored value, and one set to the empty string clears
it. They live in two ConfigMaps you can inspect:

```bash
kubectl -n moca get configmap moca-settings moca-setup -o yaml
```

## Which image runs

| Target     | Images                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base / OCP | `ghcr.io/rossoctl/moca:latest` and `ghcr.io/rossoctl/moca-remote-worker:latest`; `--image` and `--sandbox-image` override them and are stored. A `@sha256` reference becomes a digest pin |
| Kind       | Locally built `dev.local/...:local`. `setup.sh` stamps the image id on the pod templates, so a rebuilt image rolls the pods and an unchanged one does not                                 |

Redis and the OpenShift TLS sidecar are pinned by digest. **The harness image is not digest-pinned by default** and
is `:latest`; pin it with `--image <ref>@sha256:...` for repeatable upgrades. An old `latest` may predate `/readyz`,
in which case the supervisor never becomes Ready.

## How each component rolls

| Component     | Strategy                                    | What you will see                                                                                                    |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Supervisor    | Rolling, `maxUnavailable: 0`, `maxSurge: 1` | A new pod must become Ready first; in-flight turns on the old pod get the drain below                                |
| Relay         | `Recreate`, one replica                     | A short window with no relay: sandboxes detach, in-flight turns fail and are retried                                 |
| Control plane | One replica, default strategy               | Brief unavailability of login and credential exchange                                                                |
| Redis         | StatefulSet, one replica                    | See [Redis backup and recovery](redis-backup-recovery.md)                                                            |
| Sandboxes     | StatefulSet, parallel                       | Pod-local workspaces are lost: a rolled or restarted sandbox resets every container session's workspace **silently** |

A settings change rolls the supervisor and control plane through a settings-hash annotation. The first apply that
introduces sandbox tiers recreates the relay and rolls every sandbox, so do it at a quiet time.

## What an in-flight turn experiences

On a supervisor rollout the pod waits for the endpoint to leave the Service (5 seconds), then drains: workers stop
taking turns, the listener closes, and the supervisor waits up to **20 seconds** for in-flight turns. A detachable
turn still running at **15 seconds** is aborted with the message `harness restarting`. The 120-second pod grace
period is only an outer bound. Practically:

- A turn longer than about 15 to 20 seconds does not survive a rollout. The committed session does; the work in
  that turn is lost.
- Attach streams on a draining worker end without a terminal frame; a client re-attaches to another worker.
  I did not verify that `mocactl` does this automatically.
- The supervisor is PID 1, so its exit takes the workers with it.

## Version skew

- **Harness before control plane.** Config bundles require the harness to be upgraded first: an older harness
  ignores `configRef`, so turns run without the skills and report no error. Nothing enforces this order, and the
  supervisor and control plane use the same image, so one `--image` bump moves them together and the two
  Deployments roll in parallel. For a release whose notes say it changes config-bundle handling, roll the supervisor
  first (see below). Do not split the image to get this ordering.
- **Tier lists must match.** `SH_SANDBOX_TIERS` and `SH_SANDBOX_DEFAULT_TIER` are read by both from the same
  ConfigMap.
- **No schema version.** There is no schema-version key or migration tool for Redis. New fields are handled by
  tolerant reads. The only versioned artefact at rest is the credential envelope (`v1.`).
- No wire-version negotiation exists. `GET /v1/discovery` returns the control plane's `version`.

### Rolling the harness before the control plane

_Unverified: this uses plain Kubernetes commands and has not been run against `deploy/k8s`._ Pause the control
plane's rollout, apply the upgrade, wait for the supervisor, then resume:

```bash
kubectl -n moca rollout pause deployment/moca-control-plane
deploy/k8s/setup.sh --target kind --skip-build        # your usual flags, including --image
kubectl -n moca rollout status deployment/moca-supervisor
kubectl -n moca rollout resume deployment/moca-control-plane
kubectl -n moca rollout status deployment/moca-control-plane
```

`setup.sh` ends by waiting on every component in turn (Redis, relay, supervisor, control plane, sandboxes) and then
for the relay to have mirrored every sandbox. `kubectl rollout status` on a paused Deployment is expected to fail
rather than wait, so the script will probably stop at the control-plane wait and skip the sandbox and presence
checks after it. If it does, resume the rollout as above and run what was skipped:

```bash
kubectl -n moca-sandbox rollout status statefulset/moca-sandbox
kubectl -n moca exec redis-0 -- sh -c 'redis-cli HLEN sh:sandbox:records'   # should equal SH_SANDBOX_COUNT
mocactl doctor
```

For releases that do not change bundle handling, skip all of this: the window is short and only affects sessions
that use a promoted bundle.

## Rolling back

No procedure is documented. Mechanically, re-running `setup.sh` with an older `--image` rolls the Deployments back,
and plain `kubectl rollout undo` also works. Redis data is not versioned, so a rollback across a data-format change
is untested.

## Availability during a node drain

There is no PodDisruptionBudget, anti-affinity or topology spread in the manifests, and Redis, the relay and the
control plane are single replicas. Drain nodes one at a time and expect a gap.
