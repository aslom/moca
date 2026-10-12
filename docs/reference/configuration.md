# Configuration reference

> **Preview.** Describes the P6 runtime as of `main` on 2026-10-12. Variable names keep their
> historical prefixes (`SH_*`, `KAGENTI_*`, `MOCA_*`); they are listed as they exist in the code.
> Each row cites the component that reads it. Anything I could not confirm from code is marked
> _(unverified)_. The deployment READMEs ([`deploy/vm`](../../deploy/vm/README.md),
> [`deploy/k8s`](../../deploy/k8s/README.md), [`deploy/compose`](../../deploy/compose/README.md),
> [`deploy/microvm`](../../deploy/microvm/P4-ON-P6.md)) say how each path sets these; the env
> templates are in `deploy/vm/env/*.env.example`.

## Conventions

- **Secret** means the value is a credential. On a VM, `SH_EXCHANGE_TOKEN`,
  `SH_SESSION_TOKEN_PRIVATE_KEY` and `SH_CREDENTIAL_KEK` are systemd credentials
  (`LoadCredential=`), as is `SH_OPERATOR_INFERENCE_TOKEN` when configured by `setup-vm.sh`. Setting
  one of those in an env file as well makes its consumer refuse to boot. `MOCA_RELAY_EXEC_TOKEN` and
  `SH_RELAY_TOKEN` are plain `EnvironmentFile` lines (mode 0640), not credentials. Docker Compose
  passes all of them as plain env.
- **Blank values.** A blank line (`X=`) means "use the default" for most numeric knobs. Exceptions:
  blank `SH_TURNS_PER_WORKER` refuses to boot, and a blank `SH_MODEL` is kept as an empty string
  rather than defaulting.
- **Strict vs lenient parsing.** The supervisor and `SH_ROUTING_POLICY` refuse a bad value. The
  control plane silently falls back to the default on a malformed number, so a typo in a TTL variable
  produces no error.
- **Values that must agree across components** are called out in the rows (relay and supervisor
  ports and tokens, tier names, affinity TTL).

## Supervisor (parent process)

`packages/supervisor/src/config.ts`.

| Variable                       | Default                         | Required / notes                                                                                     | Meaning                                            |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `SH_TURNS_PER_WORKER`          | none                            | **Required**, at least 1; blank refuses to boot                                                      | S, the in-flight turn cap per worker               |
| `PORT`                         | `8080`                          | Integer 0-65535                                                                                      | Data-path listen port                              |
| `SH_ADMIN_PORT`                | `8081`                          | Must differ from `PORT` unless 0                                                                     | Admin listener (`/metrics`, `/healthz`, `/readyz`) |
| `SH_ADMIN_HOST`                | `127.0.0.1`                     | IP literal only. The admin listener is unauthenticated; widen it only behind your own access control | Admin bind address                                 |
| `SH_WORKERS`                   | CPU count available to the unit | Integer at least 1                                                                                   | W, the worker count                                |
| `SH_ROUTING_POLICY`            | `leastInFlight`                 | `leastInFlight` or `stickyBySession`; others refuse to boot                                          | How accepted sockets are routed                    |
| `SH_WORKER_RESTART_BACKOFF_MS` | `250`                           | Integer at least 0                                                                                   | Backoff before restarting a dead worker            |

## Worker: auth, tenancy and Redis

The worker is `packages/knative-server/src/worker.ts` (the package name is historical). It validates
`SH_SANDBOX_DISCOVERY`, `SH_REMOTE_SANDBOX` and the tier settings at boot and exits on failure.

| Variable                       | Default                   | Required / notes                                                                                 | Meaning                                                                  |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `SH_REQUIRE_AUTH`              | off (only `true` enables) | Required `true` when `MOCA_TENANCY=multi`. A bad token is refused even when off                  | Every turn needs a control-plane session token                           |
| `SH_SESSION_TOKEN_PUBLIC_KEYS` | empty                     | Malformed value fails the boot. VM: `setup-vm.sh` writes it once                                 | The control plane's public keyset, `<kid>:<base64 SPKI>`                 |
| `SH_CONTROL_PLANE_URL`         | unset                     | No boot check. VM preset `http://127.0.0.1:8090`                                                 | Where the worker reaches the control plane for credential exchange       |
| `SH_EXCHANGE_TOKEN`            | unset                     | **Secret.** Env plus credential file, or an empty file, fails the boot                           | The workers' bearer for the control plane's exchange hop                 |
| `MOCA_TENANCY`                 | `single`                  | `single` or `multi`; a near-miss spelling of the name throws. `multi` refuses `SH_LOCAL_TOOLS=1` | `multi` scrubs ambient provider credentials. No shipped template sets it |
| `SH_LOCAL_TOOLS`               | off                       | Refused under `multi`                                                                            | Single-tenant dev opt-in: run tools in the worker                        |
| `REDIS_URL`                    | `redis://127.0.0.1:6379`  | URL may carry a password                                                                         | Sessions, leases, affinity, sandbox records, turn log, bundles           |
| `CREDENTIALS_DIRECTORY`        | unset                     | systemd sets it; the K8s manifests set it by hand to `/run/credentials`                          | Where credential files are read first                                    |
| `MOCA_VERSION`                 | `dev`                     |                                                                                                  | Reported version, baked in at image build                                |
| `SH_STATS_INTERVAL_MS`         | `1000`                    | Invalid or non-positive falls back                                                               | Pace of advisory stats from workers                                      |

## Worker: sandbox selection, affinity and tiers

| Variable                            | Default                                        | Required / notes                                                                            | Meaning                                                                   |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `SH_REMOTE_SANDBOX`                 | off (only `1` enables)                         | `SH_SANDBOX_DISCOVERY=records` without `1` fails the boot                                   | Use sandbox records mirrored from the relay                               |
| `SH_SANDBOX_DISCOVERY`              | `both`                                         | `pods`, `records` or `both`. All P6 templates use `records`                                 | Which sandbox inventories are consulted                                   |
| `SH_RELAY_ADDR`                     | `sandbox-relay.default.svc.cluster.local:8443` | Must equal the relay's `MOCA_RELAY_EXEC_ADDR`, **not** its attach port                      | Address of the relay's `SandboxExec` listener                             |
| `MOCA_RELAY_EXEC_TOKEN`             | none                                           | **Secret.** Required when the exec client is built. Must equal the relay's                  | The workers' credential for the relay's `SandboxExec`                     |
| `KAGENTI_SANDBOX_POOL_SELECTOR`     | unset                                          | Templates set `app=sandbox`. If unset, the single-pod path is used                          | Label selector for the sandbox pool                                       |
| `KAGENTI_SANDBOX_CAP`               | `20`                                           | Invalid or below 1 falls back. Templates set `4`                                            | Soft cap on leases per sandbox                                            |
| `KAGENTI_SANDBOX_LEASE_TTL_MS`      | `60000`                                        | Floor 1000. Set by no template                                                              | Lease TTL                                                                 |
| `KAGENTI_SANDBOX_HEARTBEAT_MS`      | `20000`                                        | Clamped to at most TTL/3. Set by no template                                                | Lease renewal interval                                                    |
| `SH_SANDBOX_TIERS`                  | unset (untiered)                               | Comma-separated; duplicate or invalid names throw. **Must match the control plane exactly** | Declared sandbox tiers                                                    |
| `SH_SANDBOX_DEFAULT_TIER`           | the only tier, if one                          | **Required** when more than one tier is declared; must be a declared tier                   | Tier for sessions that do not choose                                      |
| `SH_SANDBOX_AFFINITY_TTL_SECONDS`   | `86400`                                        | Keep at least the P4 worker's `SH_WORKSPACE_IDLE`; **must equal the relay's copy**          | How long a session remembers its sandbox                                  |
| `SH_SANDBOX_AFFINITY_GRACE_SECONDS` | `60`                                           | `0` is legal                                                                                | How long a turn waits (503) for its sandbox before moving within the tier |

## Worker: turns, model and budget

| Variable                                   | Default                | Required / notes                                                                                                    | Meaning                                          |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `SH_TURN_DETACH`                           | off (only `1` enables) | Templates enable it                                                                                                 | Detachable, re-attachable turns                  |
| `SH_TURN_DETACHED_MAX_S`                   | `1800`                 | Blank or invalid falls back                                                                                         | Unwatched turns end after this                   |
| `SH_TURN_LOG_TTL_S`                        | `86400`                | Blank or invalid falls back                                                                                         | A finished turn stays replayable this long       |
| `SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES` | `2048`                 |                                                                                                                     | Byte cap on `tool_result` previews in the stream |
| `SH_MODEL_PROVIDER`                        | `anthropic`            |                                                                                                                     | Model provider                                   |
| `SH_MODEL`                                 | `claude-opus-4-8`      | A blank value is kept as an empty string. A session's config bundle overrides it                                    | Model id                                         |
| `SH_MODEL_CUSTOM`                          | off (only `1` enables) | Requires a base URL (below)                                                                                         | Synthesize a model not in Pi's registry          |
| `SH_MODEL_API`                             | `anthropic`            | `anthropic` or `openai*`                                                                                            | API family of the custom model                   |
| `SH_MODEL_BASE_URL`                        | none                   | A custom model throws without it, unless `ANTHROPIC_BASE_URL` (anthropic) or `OPENAI_BASE_URL` (openai) is set      | Endpoint                                         |
| `SH_MODEL_AUTH`                            | `bearer`               | `custom-header` and `none` strip the Authorization header                                                           | Auth style                                       |
| `SH_MODEL_HEADERS`                         | none                   | JSON object; `${VAR}` in values is interpolated from env. May carry secrets                                         | Extra request headers                            |
| `SH_MODEL_CONTEXT_WINDOW`                  | `131072`               |                                                                                                                     | Custom model context window                      |
| `SH_MODEL_MAX_TOKENS`                      | `8192`                 |                                                                                                                     | Custom model max tokens                          |
| `SH_BUDGET_TOKENS`, `SH_BUDGET_MARGIN`     | none                   | Applied only when a positive number                                                                                 | Token budget and margin                          |
| `ANTHROPIC_API_KEY`                        | none                   | **Secret.** Forced to a sentinel under `multi` tenancy. Whether Pi reads other provider variables is _(unverified)_ | Provider key                                     |
| `ANTHROPIC_AUTH_TOKEN`                     | none                   | **Secret.** Not used for an authenticated (control-plane) turn                                                      | Gateway bearer                                   |
| `ANTHROPIC_BASE_URL`                       | none                   |                                                                                                                     | Gateway or endpoint                              |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`        | none                   | **Secret** (key). `OPENAI_API_KEY` is seeded with `unused` for `custom-header` and `none`                           | OpenAI-compatible provider                       |
| `HARNESS_CWD`                              | process cwd            |                                                                                                                     | Turn working directory                           |

For authenticated turns, inference credentials come from the control plane per user rather than from
these variables; see [the migration guide](../migrating-from-knative.md#configuration-what-changes).

## Worker: Context Service workloads (optional)

Enabled only when `MOCA_CONTEXT_WORKLOADS_ENABLED=1` and `CONTEXT_SERVICE_URL` is set; otherwise
`/workloads` returns 501. See [`docs/context-service.md`](../context-service.md).

| Variable                                                    | Default                    | Notes                                            |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| `MOCA_CONTEXT_WORKLOADS_ENABLED`                            | off                        | Feature switch                                   |
| `CONTEXT_SERVICE_URL`                                       | none                       |                                                  |
| `CONTEXT_SERVICE_PUBLIC_URL`                                | none                       | Required for workloads; HTTPS except on loopback |
| `CONTEXT_SERVICE_TOKEN`                                     | none                       | **Secret.** Required for workloads               |
| `CONTEXT_SERVICE_NAMESPACE` (falls back to `POD_NAMESPACE`) | `default`                  |                                                  |
| `CONTEXT_SERVICE_TIMEOUT_MS`                                | `5000`                     |                                                  |
| `MOCA_CONTEXT_MAX_STORAGE_GIB`                              | `10`                       |                                                  |
| `MOCA_CONTEXT_MAX_WORKLOADS_PER_OWNER`                      | `5`                        |                                                  |
| `MOCA_CONTEXT_STORAGE_CLASSES`                              | empty (any class rejected) |                                                  |

## Sandbox relay

`packages/sandbox-relay/src/main.ts`.

| Variable                          | Default                                 | Required / notes                                                                                                      | Meaning                                                                            |
| --------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SH_RELAY_PORT`                   | `8443`                                  | Templates use `9443`. Sandboxes dial it as `RELAY_ADDR`                                                               | Attach bind port (all interfaces)                                                  |
| `MOCA_RELAY_EXEC_ADDR`            | unset (exec shares the attach listener) | Templates set a separate listener. The supervisor's `SH_RELAY_ADDR` must dial this                                    | Bind address for `SandboxExec`                                                     |
| `MOCA_RELAY_EXEC_TOKEN`           | none                                    | **Secret, required.** The relay refuses to boot without it, or if it equals `SH_RELAY_TOKEN` or any per-sandbox token | Exec caller credential; must equal the supervisor's                                |
| `SH_RELAY_TOKEN`                  | none                                    | **Secret.** Attach is fail-closed: with no token every attach is rejected. An empty value counts as missing           | Shared sandbox attach token; must match each sandbox's `SANDBOX_TOKEN`             |
| `SH_RELAY_TOKEN_<sandboxId>`      | falls back to `SH_RELAY_TOKEN`          | **Secret.** Id must match `^[A-Za-z_][A-Za-z0-9_]*$`; `DIR` is reserved. `setup-microvm.sh` writes these              | Per-sandbox token (dashes in an id become underscores; systemd drops dashed names) |
| `SH_RELAY_TOKEN_DIR`              | unset                                   | One file per sandbox id, read on each attach; an unreadable or empty file refuses. K8s mounts `/run/relay-tokens`     | Token directory                                                                    |
| `SH_SANDBOX_AFFINITY_TTL_SECONDS` | `86400`                                 | **Must match the supervisor's**                                                                                       | TTL of the detach mark                                                             |
| `REDIS_URL`                       | `redis://127.0.0.1:6379`                | Same Redis as the supervisor                                                                                          | Sandbox pool mirror                                                                |

## Control plane

`packages/control-plane/src/main.ts`.

| Variable                                                                                                                                                 | Default                   | Required / notes                                                                                                 | Meaning                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SH_SESSION_TOKEN_PRIVATE_KEY`                                                                                                                           | none                      | **Secret, required**                                                                                             | Token signing key                                       |
| `SH_CREDENTIAL_KEK`                                                                                                                                      | none                      | **Secret, required**; must decode as a valid key ring                                                            | Envelope-encryption key ring for stored credentials     |
| `SH_EXCHANGE_TOKEN`                                                                                                                                      | none                      | **Secret, required.** Same value as the workers'                                                                 | Bearer workers present for the exchange hop             |
| `SH_GITHUB_CLIENT_ID`                                                                                                                                    | none                      | **Required.** A GitHub OAuth app with device flow enabled; no client secret                                      | Login                                                   |
| `SH_PUBLIC_HARNESS_URL`                                                                                                                                  | unset                     | Code does not require it (discovery returns `harnessUrl: null`), but the VM installer does. Absolute http(s) URL | Harness URL advertised to clients (`GET /v1/discovery`) |
| `SH_CONTROL_PLANE_PORT`                                                                                                                                  | `8080`                    | VM template uses `8090` (8080 is the supervisor's). Invalid silently falls back                                  | Listen port                                             |
| `SH_CONTROL_PLANE_HOST`                                                                                                                                  | all interfaces            | VM template sets `127.0.0.1`: plain HTTP, reach it through a tunnel                                              | Bind address                                            |
| `REDIS_URL`                                                                                                                                              | `redis://127.0.0.1:6379`  | Retries forever                                                                                                  | Ownership index, refresh tokens, bundles                |
| `SH_CREDENTIAL_STORE`                                                                                                                                    | `kubernetes`              | `kubernetes`, `file` or `vault`. VM and Compose use `file`                                                       | Credential store backend                                |
| `SH_CREDENTIAL_DIR`                                                                                                                                      | none                      | Required for `file`                                                                                              | File store path                                         |
| `SH_CREDENTIAL_NAMESPACE`                                                                                                                                | `sh-credentials`          | Kubernetes store; the K8s manifests use `moca-credentials`                                                       | Secret namespace                                        |
| `VAULT_ADDR`, `VAULT_TOKEN` or `VAULT_TOKEN_FILE` (exactly one), `VAULT_NAMESPACE`, `SH_VAULT_KV_MOUNT` (`secret`), `SH_VAULT_PATH` (`moca/credentials`) | none                      | Vault store only; no template wires it. Token is a **secret**                                                    | Vault credential store                                  |
| `SH_ADMIN_SUBJECTS`                                                                                                                                      | none                      | Comma-separated `github:<id>`                                                                                    | Admin role                                              |
| `SH_DEFAULT_INFERENCE_ENDPOINT`                                                                                                                          | none                      | Validated if set. For Anthropic use `https://api.anthropic.com` (no `/v1`)                                       | Gateway origin for credentials with no endpoint         |
| `SH_ALLOW_OPERATOR_FALLBACK`                                                                                                                             | off (only `true` enables) | `true` requires the token and endpoint, mutually consistent, or boot fails                                       | Users without their own credential spend the operator's |
| `SH_OPERATOR_INFERENCE_TOKEN`                                                                                                                            | none                      | **Secret.** On a VM, a credential file via a drop-in `setup-vm.sh` creates; never an env line                    | The operator's inference key                            |
| `SH_OPERATOR_INFERENCE_HEADER`                                                                                                                           | `authorization`           | `authorization` or `x-api-key`; an Anthropic API key needs `x-api-key`                                           | Header the operator key travels in                      |
| `SH_API_TOKEN_TTL_SECONDS` / `SH_SESSION_TOKEN_TTL_SECONDS`                                                                                              | `900` / `300`             | Invalid silently falls back                                                                                      | Token lifetimes                                         |
| `SH_REFRESH_IDLE_TTL_SECONDS` / `SH_REFRESH_MAX_TTL_SECONDS`                                                                                             | `2592000` / `7776000`     | Idle must not exceed max                                                                                         | Refresh token lifetimes                                 |
| `SH_REFRESH_REUSE_GRACE_SECONDS`                                                                                                                         | `30`                      | Above 300 throws                                                                                                 | Grace for a retried refresh                             |
| `SH_SANDBOX_TIERS` / `SH_SANDBOX_DEFAULT_TIER`                                                                                                           | as for the worker         | Must match the supervisor's exactly                                                                              | Tiers a session may choose                              |
| `SH_BUNDLE_SUBJECT_BYTES` / `SH_BUNDLE_TOTAL_BYTES`                                                                                                      | 16 MiB / 64 MiB           | Positive integer strings or boot fails                                                                           | Config-bundle byte budgets                              |
| `SH_SESSION_TOKEN_PUBLIC_KEYS`                                                                                                                           | empty                     | Malformed throws                                                                                                 | Extra public keys for rotation                          |
| `SH_INJECTOR_CONFIGURED`                                                                                                                                 | off                       | No template sets it                                                                                              | Skips the direct-mode mismatch check                    |
| `SH_SANDBOX_NAMESPACE`                                                                                                                                   | `default`                 | Used on Kubernetes paths                                                                                         | Sandbox namespace                                       |

## Sandbox workers (Go)

### Container sandbox (`remote-worker/cmd/worker`)

| Variable                         | Default            | Notes                                                                                                     |
| -------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `RELAY_ADDR`                     | `localhost:8443`   | The relay's attach address                                                                                |
| `SANDBOX_TOKEN`                  | `dev-token`        | **Secret.** Equals the relay's `SH_RELAY_TOKEN` (or its per-sandbox token). Do not leave the default      |
| `RELAY_TLS`, `RELAY_CA_FILE`     | off                | TLS to the relay; a garbage `RELAY_TLS` is fatal                                                          |
| `SANDBOX_ID`                     | `sbx-laptop-1`     | Unique per sandbox                                                                                        |
| `SANDBOX_TIER`                   | `container`        | Advertised as the `moca.dev/tier` label. If set but blank, no label: a tiered harness excludes the worker |
| `WORKER_MAX_CONCURRENT`          | `4`                | Concurrency slots; garbage or non-positive falls back                                                     |
| `SANDBOX_IMAGE`, `SANDBOX_TRUST` | empty, `untrusted` | Labels                                                                                                    |
| `SH_WORKSPACE_ROOT`              | built-in default   | Absolute path                                                                                             |
| `SH_WORKSPACE_IDLE`              | built-in default   | Go duration; idle time after which a session workspace is deleted                                         |

Commands run in a sandbox do not inherit the worker's own settings: `SANDBOX_TOKEN`, `RELAY_*`,
`SANDBOX_*`, `WORKER_MAX_CONCURRENT` and anything prefixed `SH_` or `MOCA_` are stripped.

### MicroVM worker (`remote-worker/cmd/microvm-worker`)

It reads the same `RELAY_*` and `SANDBOX_*` variables (defaults `SANDBOX_ID=sbx-microvm-1`,
`SANDBOX_TIER=microvm`) and `WORKER_MAX_CONCURRENT`, plus:

| Variable                                                | Default           | Notes                                                                                |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `SH_SNAPSHOT_DIR`                                       | none              | **Required**                                                                         |
| `SH_WORKSPACE_ROOT`                                     | none              | **Required**                                                                         |
| `SH_MAX_COMMITTED_MB`                                   | none              | **Required**, positive integer. Without it the OOM gate is absent                    |
| `SH_VMM`                                                | `firecracker`     | `fake` and unknown values are refused                                                |
| `SH_STANDBY_DEPTH`                                      | built-in          | Warm standby VMs                                                                     |
| `SH_GUEST_RAM_MB`                                       | built-in          | Per-guest RAM                                                                        |
| `SH_MAX_RUNS`                                           | `64`              | Positive integer                                                                     |
| `SH_MEMORY_RESERVE_MB`                                  | none              | Positive integer if set                                                              |
| `SH_WORKSPACE_IDLE`                                     | built-in          | Go duration; `setup-microvm.sh` sets it from `MICROVM_WORKSPACE_IDLE` (default `8h`) |
| `SH_PARENT_CGROUP`                                      | built-in          | Slice-relative; under systemd a nonexistent path is fatal                            |
| `SH_JAILER_BIN`, `SH_FIRECRACKER_BIN`, `SH_CHROOT_BASE` | PATH, `/srv/jail` | Binary and jail locations                                                            |
| `SH_WORKSPACE_IMAGE_MB`                                 | `2048`            | Positive integer                                                                     |
| `SH_SNAPSHOT_IMAGE`                                     | `default`         |                                                                                      |
| `SH_VIRTIOFSD_UID`, `SH_VIRTIOFSD_GID`                  | `65534`           | Positive integers                                                                    |

Diagnostic switches (`SH_DIAG_PPROF`, `SH_DIAG_STATS_ADDR`, `SH_DIAG_PHASES`) and the Cloud
Hypervisor variables (`SH_CHV_*`, `SH_CH_REMOTE_BIN`, `SH_VIRTIOFSD_BIN`) exist but are not part of
the supported setup.

## mocactl

| Variable               | Default                      | Notes                                                   |
| ---------------------- | ---------------------------- | ------------------------------------------------------- |
| `SH_CONTROL_PLANE_URL` | saved config                 | Precedence: flag, env, config                           |
| `SH_HARNESS_URL`       | saved config, else discovery | Overrides the harness URL that discovery returns        |
| `XDG_CONFIG_HOME`      | `~/.config`                  | `mocactl/config.json` and the login file (holds tokens) |
| `XDG_STATE_HOME`       | `~/.local/state`             | Transcripts and exports                                 |
| `VISUAL` / `EDITOR`    | `vi`                         | External editor                                         |
| `NO_COLOR`             | off                          | Disables colour when non-empty                          |

`MOCACTL_VERSION` and `MOCACTL_INSTALL_DIR` are read by the installer
(`scripts/install-mocactl.sh`), not by `mocactl` itself.

## Installer-time variables

Read by `setup-vm.sh`, `setup-microvm.sh`, `deploy/compose/install.sh` and `deploy/k8s/setup.sh`,
not by the runtime. Each script's header is authoritative.

- **Paths and image:** `SH_UNIT_DIR`, `SH_ENV_DIR`, `SH_INSTALL_DIR`, `SH_CRED_DIR`, `SH_REPO_ROOT`,
  `SH_SANDBOX_COUNT`, `SANDBOX_IMAGE`, `SH_SANDBOX_RELAY_ADDR`, `SH_BIN_DIR`.
- **VM sandbox network:** `MOCA_SANDBOX_SUBNET`, `MOCA_SANDBOX_GATEWAY`, `MOCA_SANDBOX_BRIDGE`.
- **Control-plane inputs:** `SH_GITHUB_CLIENT_ID`, `SH_PUBLIC_HARNESS_URL`.
- **MicroVM installer:** `MICROVM_SANDBOX_ID`, `MICROVM_WORKSPACE_IDLE`, `MICROVM_SNAPSHOT_DIR`,
  `MICROVM_BIN`, `MICROVM_ATTACH_TIMEOUT`, `MICROVM_ATTACH_SETTLE`, `MICROVM_MAX_COMMITTED_MB`.
- **Compose:** `SH_COMPOSE_DIR`, `SH_COMPOSE_BASE_URL`, `SH_HARNESS_IMAGE`, `SH_SANDBOX_IMAGE`,
  `SH_PORT`, `SH_CP_PORT`, `MOCA_RELAY_EXEC_PORT`, `MOCA_RELAY_BRAIN_IP`, `MOCA_BRAIN_SUBNET`,
  `COMPOSE_PROFILES`.
- **Kubernetes:** `SH_P4_SANDBOX_IDS`, `SH_SANDBOX_EGRESS_EXCEPT`, `SH_ROUTE_DOMAIN`,
  `SH_SINGLE_NAMESPACE`, `SH_WAIT_SECONDS`.

## Legacy: Knative-only variables

Read by code that runs only on the deprecated Knative/KEDA path (or shared code with no P6 setting).
No P6 template sets them.

| Variable                                                                                | Notes                                                           |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `K_SERVICE`, `K_CONFIGURATION`, `K_REVISION`                                            | Guard for the deprecation warning (`deprecation.ts`)            |
| `LEAF_RESULT_TTL_SECONDS` (default `86400`)                                             | TTL of `/runs` sync-leaf results and the KEDA job path          |
| `KAGENTI_SYNC_SATURATION_WAIT_MS`, `_BACKOFF_MS`, `_MAX_BACKOFF_MS`                     | `/runs` sync saturation retry (defaults `30000`, `250`, `5000`) |
| `KAGENTI_SYNC_SATURATION_RETRY_AFTER_S` (default `5`)                                   | Also used for `/turn` retry headers, so live on P6              |
| `SH_SERVICE_URL`, `JOB_NAME`, `CRON_CONFIG`                                             | The CronJob on-ramp (`cron-dispatch`)                           |
| `KAGENTI_SANDBOX_POD`, `_NAME`, `_NAMESPACE`, `_CONTEXT`, `_CWD`, `KAGENTI_EXEC_TIMING` | Single-pod `kubectl exec` sandbox transport                     |

## Known inconsistencies

- `SH_PUBLIC_HARNESS_URL` is documented as required in the VM env template, but only the installer
  enforces it.
- `SH_PERSISTENT_EXEC` and `ANTHROPIC_MODEL` appear in the supervisor `/metrics` allowlist but are
  read by no P6 code; `SH_WORKER_ID` is set for each forked worker and no reader was found.
- `SH_ROUTING_POLICY=stickyBySession` is valid but appears in no template.
