# SBX0 sandbox service

The sandbox control plane, the sandbox relay and Redis in one namespace of a shared OpenShift
cluster. Three Routes reach them: **api** (edge TLS, the control plane: login and the sandbox
resource), **attach** (passthrough, KVM hosts' workers dial in) and **exec** (passthrough, clients'
`Exec` calls). Design:
[`docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md).

## 1. Cluster side

Needs `kubectl` logged in with edit rights in an **existing** namespace, `jq`, and an `openssl` that
makes Ed25519 keys (OpenSSL 1.1.1 or later; on macOS, `brew install openssl@3`). The namespace must
be **dedicated to SBX0**: the overlay's default-deny and relay NetworkPolicies would cut off anything
else running in it. Keep the inputs in a file outside the repo:

    SBX_NAMESPACE=<namespace>
    SBX_API_HOST=<api route host>
    SBX_ATTACH_HOST=<attach route host>
    SBX_EXEC_HOST=<exec route host>         # three distinct hosts
    SBX_IMAGE=<image ref>
    SBX_WORKERS="sbx_default sbx_py312"     # one worker id per template
    SBX_TEMPLATES_FILE=<templates.json>     # below
    SBX_GITHUB_CLIENT_ID=<client id>        # this deployment's own GitHub OAuth app (device flow)
    SBX_ALLOWED_SUBJECTS=github:<id>,github:<id>   # who may log in: numeric GitHub user ids
    SBX_ADMIN_SUBJECTS=github:<id>          # optional
    SBX_WORKSPACE_FS_GIB=<n>                # the KVM host's workspace filesystem size, in GiB

    deploy/sbx/setup.sh --env-file <file>

Optional inputs:

| Variable                               | Default | Rule                                                                       |
| -------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `SBX_LIFETIME_DAYS`                    | 7       | 1-30; each worker's idle reclaim is set to this plus two days              |
| `SBX_MAX_PER_SUBJECT`, `SBX_MAX_TOTAL` | 3, 40   | live sandboxes per user, and in all                                        |
| `SBX_MAX_INFLIGHT`                     | 2       | 1-8: `Exec` calls one sandbox may have in flight at the relay              |
| `SBX_WORKSPACE_IMAGE_MB`               | 2048    | each workspace's image size (`microvm-worker`'s `SH_WORKSPACE_IMAGE_MB`)   |
| `SBX_{API,ATTACH,EXEC}_TLS_{CERT,KEY}` | none    | the Route's certificate; otherwise the router's (api) or a self-signed one |

The templates file lists one template per worker in `SBX_WORKERS`. A template id is lower-case
letters, digits and dashes, and unique; `tools` is what `mocactl sbx` shows:

```json
[
  {
    "id": "default",
    "worker": "sbx_default",
    "description": "bash, git, Python 3",
    "tools": ["bash", "git", "python3"]
  },
  { "id": "py312", "worker": "sbx_py312", "description": "Python 3.12", "tools": ["python3.12"] }
]
```

The run refuses, before applying anything, when `SBX_MAX_TOTAL` × `SBX_WORKSPACE_IMAGE_MB` exceeds
80 % of `SBX_WORKSPACE_FS_GIB`: the quota is the disk control.

Re-run it after any change; tokens, the signing key and certificates are kept. A change to any
setting rolls the control plane and the relay, which read their settings only at boot. Without
`SBX_{ATTACH,EXEC}_TLS_CERT/KEY` those Routes use self-signed certificates: the attach one ships in
every worker bundle, and the control plane hands the exec one to clients.

**Upgrading from 1a:** unset `SBX_CLIENTS` (the run refuses it). The run deletes the static client
tokens and their bundles, and removes the relay's harness exec token. Re-run `install-host.sh` with
the new worker bundles, which now carry the workspace idle time and image size.

## 2. KVM host side

The host needs what `deploy/microvm/P4-ON-P6.md` lists for P4 (`/dev/kvm`, Firecracker, jailer,
`microvm-worker`) and outbound TCP 443 to the attach host. Build each template's snapshot under
`/srv/sbx/snapshots/<image>` with `deploy/microvm/build-snapshot.sh`, then per worker:

    scp -r deploy/sbx/.generated/workers/<id> <host>:sbx-<id>
    ssh <host> sudo <checkout>/deploy/sbx/install-host.sh sbx-<id> --snapshot <image> [--budget-mb N]
    ssh <host> rm -r sbx-<id>

The script waits up to `SBX_ATTACH_TIMEOUT` (120 s) for the worker's attach to hold. A newly added
worker's token reaches the relay only when the kubelet syncs the Secret, about a minute, so the first
attaches may be refused. Re-running it restarts the worker once, with the new env file.
`install-host.sh --uninstall <id>` removes a worker and keeps its workspace data.

## 3. Users

Users log in with GitHub and create sandboxes from a template:

    mocactl sbx login --control-plane-url https://<api host>
    mocactl sbx create --template <id>

To call the gRPC API directly, see `docs/api/sandbox-v1-direct-client.md`.
