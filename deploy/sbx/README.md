# SBX0 front door (increment 1a)

The sandbox relay and Redis in one namespace of a shared OpenShift cluster, reached through two
passthrough Routes: **attach** (KVM hosts' workers dial in) and **exec** (clients). Design:
[`docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md).

## 1. Cluster side

Needs `kubectl` logged in with edit rights in an **existing** namespace, `jq` and `openssl`. The
namespace must be **dedicated to SBX0**: the overlay's default-deny and relay NetworkPolicies would cut
off anything else running in it. Keep the inputs in a file outside the repo:

    SBX_NAMESPACE=<namespace>
    SBX_ATTACH_HOST=<attach route host>
    SBX_EXEC_HOST=<exec route host>
    SBX_IMAGE=<relay image ref>
    SBX_WORKERS="sbx_default"            # one worker id per template
    SBX_CLIENTS="<name> <name>"          # increment 1a only: static client tokens

    deploy/sbx/setup.sh --env-file <file>

Re-run it after any change; tokens and certificates are kept. A change to `SBX_CLIENTS` or
`SBX_WORKERS` that changes the client tokens rolls the relay, since it reads them only at boot. Without
`SBX_*_TLS_CERT/KEY` the Routes use self-signed certificates, shipped in every bundle.

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

## 3. Clients (increment 1a)

Each `deploy/sbx/.generated/clients/<name>/` holds `client.env` and, with a self-signed certificate,
`exec-ca.crt`. Hand it to its owner and delete the copy. The owner loads it from inside the bundle
directory, making the CA path absolute so it holds from anywhere:

    cd <bundle directory>
    set -a; . ./client.env; set +a
    [ -f exec-ca.crt ] && export SBX_CA_FILE="$PWD/exec-ca.crt"

These static client tokens work only with the team-only 1a relay image (built from the prototype
branch, never merged); a relay built from `main` ignores them. Increment 1b replaces them with
`mocactl sbx login`.
