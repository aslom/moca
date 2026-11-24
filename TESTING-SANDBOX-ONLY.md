# Testing a sandbox-only MOCA deployment with test users

This branch deploys **MOCA sandbox-only** (`--profile sandbox`): the `sbx` service with no
harness, and browser-free `test:1..1000` logins. Everything below targets that profile only.

**This file is test scaffolding. Drop this commit before merging anything.** The branch is
`main` plus the heads of the three OPEN PRs below, in dependency order; it exists only so they can
be tested together. Four of the six changes it used to carry -- #1004, #1017, #1018 and #1019 --
merged on 2026-11-24 and now come from `main` itself, so they are no longer separate commits here.

| Source   | PR                                                  | What it adds                                                                                                           |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `main`   | [#1004](https://github.com/rossoctl/moca/pull/1004) | `mocactl sbx login --test-user N` — browser-free login for `test:N` (**merged**)                                       |
| `main`   | [#1018](https://github.com/rossoctl/moca/pull/1018) | `SH_SANDBOX_TEST_USERS_ENROLLED=true` enrols `test:1..SH_TEST_USERS` for the sandbox routes (**merged**)               |
| `main`   | [#1017](https://github.com/rossoctl/moca/pull/1017) | Route certificate CN uses the host's first label, so a long apps domain no longer aborts the install (**merged**)      |
| `main`   | [#1019](https://github.com/rossoctl/moca/pull/1019) | kustomize Component adding the sandbox service to an `ocp-single` stack (**merged**)                                   |
| commit 1 | [#1020](https://github.com/rossoctl/moca/pull/1020) | `deploy/k8s/setup.sh --profile combined`                                                                               |
| commit 2 | [#1023](https://github.com/rossoctl/moca/pull/1023) | test users on the `sandbox` profile — the control-plane half, and the client that logs in                              |
| commit 3 | [#1024](https://github.com/rossoctl/moca/pull/1024) | **`--profile sandbox`** — the installer half ([#1022](https://github.com/rossoctl/moca/issues/1022) needs both halves) |

#1023 and #1024 together are what make sandbox-only possible, and they are one change split
across two PRs — because their halves have different ancestors and neither branch can carry the
other's:

- **[#1023](https://github.com/rossoctl/moca/pull/1023)** (on #1020) — the control-plane half: test users are no
  longer refused on the `sandbox` profile. This reverses an ADR-0045 decision, and the reason the
  original is obsolete is stated there: `SUBJECT_RE` admits `test:<n>` and #1018 enrols the range,
  so a test user genuinely can be enrolled on that profile now.
- **[#1024](https://github.com/rossoctl/moca/pull/1024)** (on #1023, on #1020) — the installer half: `--profile sandbox` and the
  `overlays/ocp-single/sandbox` Component, held back from #1020 as a follow-up.

Both address **[#1022](https://github.com/rossoctl/moca/issues/1022)**, and neither carries a closing keyword. The three are now a
LINEAR stack -- #1020, then #1023, then #1024 -- and the shape is not cosmetic: #1020 inserts the
`SH_SANDBOX_TEST_USERS_ENROLLED` row directly below the `SH_TEST_USERS` row #1023 rewrites, and
adjacent edits do not auto-merge, so whichever merged second would conflict; #1024 then touches the
same two documentation files again. Stacking removes every one of those collisions, so this branch
is simply #1024's head plus this file. The capability needs all three: #1024 without #1023 installs
a stack whose `sbx login --test-user N` the client refuses, and whose control plane crash-loops as
soon as `SH_TEST_USERS` is set on this profile.

## Verified on real clusters

| Cluster                                                             | Result                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ykt1** (`moca-sbx`, Routes admitted, 25-byte apps domain)         | ✅ `profile: sandbox` over the Route; `test:1000` login → `create` → `run -- id` → `run -- uname -a` → `ls` → `rm`, with no port-forward and no local TLS setup                                                         |
| **avek2** (`avek2`, Routes never admitted, **98-byte** apps domain) | ✅ installer `EXIT=0`; `test:1000` login → `create` → `run -- id` → `run -- uname -a` → `ls` → `rm`, over `port-forward` with the exec endpoint repointed at `localhost` (see _Clusters whose Routes are not admitted_) |

On both, the installer reports the worker attach rather than merely a Ready pod, and
`SH_SANDBOX_COUNT=0` means no session pool is created.

**Re-verified on ykt1 on 2026-11-24**, after the review round, with the heads this branch now
carries -- the avek2 line above predates it. Each item was A/B'd against the pre-fix installer or
client on the same stack, so these are measurements rather than expectations:

| What                                          | Pre-fix                                                                                              | Now                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `--tls-secret` with a profile that serves sbx | `SH_SANDBOX_EXEC_CA` **vanished** from `sbx-settings`, so every client exec would fail the handshake | the key is back, byte-identical, nothing rotated                   |
| `SH_SANDBOX_EGRESS_EXCEPT=203.0.113.0/24`     | in `NetworkPolicy/moca-sandbox` only                                                                 | in `moca-sandbox` **and** `sbx-worker`                             |
| `deployment/sbx-worker` pod template          | no annotations at all                                                                                | carries `moca.dev/workspace-idle`, and rolls when it changes       |
| `sbx-settings` token issuer                   | `moca-sandbox`                                                                                       | `sbx-control-plane`, the code default, with the flow still working |
| `mocactl sbx login --test-user N`             | exit 2, "serves no test users: only a combined control plane does"                                   | `logged in to the sandbox service as Test User 1000`               |

An unchanged re-run moved neither the control plane's `moca.dev/settings-hash` nor the relay's own
stamp, and the whole flow (`login` → `create` → `run -- id; uname -sr` → `ls` → `rm --force`) passes
for `test:1000` and `test:1`: `uid=1000920000`, `Linux 5.14.0-570.131.1.el9_6.x86_64`.

avek2 is where [#1017](https://github.com/rossoctl/moca/pull/1017) is actually proven. Its exec
Route host is 114 bytes, and the certificate the installer issued reads:

```
CN:      moca-exec-avek2                                    (15 bytes, cap is 64)
SAN DNS: moca-exec-avek2.etevpc-…-0000.us-east.containers.appdomain.cloud   (114 bytes, no cap)
```

Without that fix `openssl req` refuses outright (`string too long: maxsize=64`) and the install
aborts before writing any Route certificate, so this stack could not be installed from `main` at
all. ykt1's short domain never reaches the limit.

## Quick start

A sandbox-only stack with 1000 test users, on a cluster whose Routes are admitted. Each step is
explained in its own section below; this is the whole path in one place.

```bash
# 1. the cluster and namespace (ocp-single will NOT create the namespace)
export KUBECONFIG=<kubeconfig>
export SH_SINGLE_NAMESPACE=<namespace>

# 2. a control-plane image built from THIS branch, by digest (see "Why a released image will not do")
IMG=<registry>/<image>@sha256:<digest>

# 3. the settings
export SH_ROUTE_DOMAIN="$(kubectl get ingresses.config/cluster -o jsonpath='{.spec.domain}')"
export SH_IDENTITY_PROVIDER=github
export SH_GITHUB_CLIENT_ID=<github oauth app client id>
export SH_ALLOWED_SUBJECTS=github:<your numeric github id>
export SH_TEST_USERS=1000
export SH_SANDBOX_TEST_USERS_ENROLLED=true
export SH_SANDBOX_COUNT=0

# 4. install, reading the exit code directly (never through a pipe)
deploy/k8s/setup.sh --target ocp-single --profile sandbox --image "$IMG"

# 5. drive a test user (mocactl-dev is built from this branch -- see "The client also comes from this branch")
export MOCA_TEST_USER_SECRET="$(kubectl -n $SH_SINGLE_NAMESPACE get secret moca-test-users -o jsonpath='{.data.SH_TEST_USER_SECRET}' | base64 -d)"
export MOCACTL_SBX_URL="https://moca-control-plane.$SH_ROUTE_DOMAIN"
export XDG_CONFIG_HOME="$(mktemp -d)"
mocactl-dev sbx login --test-user 1000
mocactl-dev sbx create --template default --name t1000
mocactl-dev sbx run --sandbox t1000 -- id
mocactl-dev sbx run --sandbox t1000 -- uname -a
mocactl-dev sbx rm --force t1000
```

Expected: the installer ends with `the sandbox worker sbx_default attached to the relay`,
`/v1/discovery` reports `profile: sandbox`, and the two `run` commands execute in the sandbox.

If the namespace already runs MOCA, read _Deploying to an existing OpenShift stack_ first — there
are two steps that silently break an existing stack if skipped.

## Why a released image will not do

The TypeScript changes are #1004, #1018 (both merged to `main` on 2026-11-24, but **not yet in a
release**) and #1023 (still open). A released `ghcr.io/rossoctl/moca` image carries none of the
three, so
`SH_SANDBOX_TEST_USERS_ENROLLED` would be written to `sbx-settings` and ignored: `test:N` logs in
and `sbx create` then answers `not_enrolled`. Build the control plane from this branch.

On OpenShift, a BuildConfig in the target namespace is the path that needs no local amd64 builder.
Deploy **by digest** — `:latest` leaves the pod template unchanged and nothing rolls.

## The client also comes from this branch

`sbx login --test-user N` is commit 1 (#1004), so a released or installed `mocactl` does not have
the flag — it fails `unknown option`. Build it from this checkout:

```bash
pnpm install
pnpm --filter @moca/mocactl build        # -> packages/mocactl/dist/mocactl.mjs
alias mocactl-dev="node $PWD/packages/mocactl/dist/mocactl.mjs"
```

Every `mocactl-dev` below is that binary -- a distinct name, so it cannot be confused with an
installed `mocactl` that lacks the flag. `node --import tsx packages/mocactl/src/main.ts` runs it
from source without a build if you prefer.

## Environment variables

Set in the shell before `setup.sh`. The installer stores most of them in ConfigMap `moca-setup`
and reuses them on a re-run, so a second run needs only what you want to change.

| Variable                         | Needed           | What it does                                                                                                                                                                                        |
| -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KUBECONFIG`                     | yes              | which cluster and which user                                                                                                                                                                        |
| `SH_SINGLE_NAMESPACE`            | yes              | target namespace. `--target ocp-single` will **not** create it                                                                                                                                      |
| `SH_ROUTE_DOMAIN`                | yes              | the cluster's apps domain; the exec Route's host is derived as `moca-exec-<ns>.<domain>`                                                                                                            |
| `SH_GITHUB_CLIENT_ID`            | yes              | required on **every** profile. Without it (or `SH_OIDC_ISSUER`) the control plane crash-loops — test users are an extra login path, never a substitute for a provider                               |
| `SH_IDENTITY_PROVIDER`           | yes              | `github`                                                                                                                                                                                            |
| `SH_ALLOWED_SUBJECTS`            | yes              | comma-separated subjects allowed on the sandbox routes, e.g. `github:<numeric id>`. Exact strings only — `SUBJECT_RE` has no range syntax                                                           |
| `SH_TEST_USERS`                  | yes              | how many `test:N` may log in. Hard cap 1000                                                                                                                                                         |
| `SH_SANDBOX_TEST_USERS_ENROLLED` | yes              | `true` enrols `test:1..SH_TEST_USERS` on the sandbox routes (#1018). Read as exactly `true`, so `1` and `TRUE` do nothing                                                                           |
| `SH_TEST_USER_SECRET`            | optional         | the shared login secret. Omit it and the installer reuses the stored value from `secret/moca-test-users`, or generates one on a first install                                                       |
| `SH_SANDBOX_COUNT`               | no               | replicas of the harness session pool. `--profile sandbox` defaults it to `0` (#1024), since its supervisor is at 0 replicas and the pool would answer nothing. Set it only to ask for a pool anyway |
| `SH_ROUTE_PROFILE`               | **never set it** | `setup.sh` dies on any value, empty included. Use `--profile`                                                                                                                                       |

Client-side, for driving a test user:

| Variable                | What it does                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MOCA_TEST_USER_SECRET` | must equal the cluster's `SH_TEST_USER_SECRET`                                                                      |
| `MOCACTL_SBX_URL`       | the control-plane Route. Needed **beyond** `login`: without it every later command fails `no sandbox control plane` |
| `XDG_CONFIG_HOME`       | one profile directory per test user, so runs do not clobber each other                                              |

## Deploying to an EXISTING OpenShift stack

The common case: a namespace that already runs MOCA from `setup.sh`. The variables are the
_Quick start_'s; these four steps are what differs from a fresh install.

**1. Do not create the namespace, and capture the test-user secret first.** The installer reads it
from `secret/moca-test-users` only. A stack installed before that Secret existed keeps the key in
`secret/moca-mu1`, and the installer will then generate a _new_ secret and silently break every
existing `test:N` login:

```bash
export SH_SINGLE_NAMESPACE=<namespace>
export SH_TEST_USER_SECRET="$(kubectl -n $SH_SINGLE_NAMESPACE get secret moca-test-users -o jsonpath='{.data.SH_TEST_USER_SECRET}' | base64 -d)"
echo "length: ${#SH_TEST_USER_SECRET}"     # 64 for a hex-32 value; empty means check moca-mu1
```

**2. Delete a previous combined install's exec Route.** If the namespace was installed from an
earlier revision of these PRs, its exec Route object is named `moca-exec`, while this branch renders
it as `sbx-exec` with the **same host** — so the new object is rejected `HostAlreadyClaimed` and the
stale Route keeps serving:

```bash
kubectl -n $SH_SINGLE_NAMESPACE delete route moca-exec --ignore-not-found
```

**3. Build the control plane from this branch.** #1004, #1018 and #1023 are TypeScript, and no
released image carries them -- the first two are on `main` but unreleased, the third is still open. The cheapest path on OpenShift overlays this branch's three changed
control-plane sources onto a released image, which avoids the full `npm ci`/`pnpm install` build
(both of which fail on slow single fetches):

```bash
NS=$SH_SINGLE_NAMESPACE
kubectl -n $NS create configmap cp-src-patch \
  --from-file=packages/control-plane/src/main.ts \
  --from-file=packages/control-plane/src/routes.ts \
  --from-file=packages/control-plane/src/sandbox-config.ts
cat <<'EOF' | kubectl -n $NS apply -f -
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata: {name: moca-cp-sbx}
EOF
oc -n $NS new-build --name moca-cp-sbx --binary --strategy docker --to moca-cp-sbx || true
```

with a Dockerfile of the shape verified on a live cluster:

```dockerfile
FROM ghcr.io/rossoctl/moca:<released tag>
COPY cp-src/main.ts /app/packages/control-plane/src/main.ts
COPY cp-src/routes.ts /app/packages/control-plane/src/routes.ts
COPY cp-src/sandbox-config.ts /app/packages/control-plane/src/sandbox-config.ts
```

Then resolve the **digest** and pass it to the installer. `:latest` leaves the pod template
unchanged, so nothing rolls:

```bash
IMG=$(kubectl -n $NS get istag moca-cp-sbx:latest -o jsonpath='{.image.dockerImageReference}')
echo "$IMG"
```

If your cluster can build the repository normally, or you can push an amd64 image from a machine
with a working builder, do that instead and skip this step.

**4. Run the installer, then drop the build scaffolding.** Inputs already stored in `moca-setup`
are reused, so pass only what changes:

```bash
export SH_ROUTE_DOMAIN=<cluster apps domain>
export SH_ALLOWED_SUBJECTS=github:<your numeric github id>
export SH_TEST_USERS=1000
export SH_SANDBOX_TEST_USERS_ENROLLED=true
export SH_SANDBOX_COUNT=0
export SH_GITHUB_CLIENT_ID=<github oauth app client id>
deploy/k8s/setup.sh --target ocp-single --profile sandbox --image "$IMG"
kubectl -n $SH_SINGLE_NAMESPACE rollout status deploy/moca-control-plane --timeout=600s
kubectl -n $SH_SINGLE_NAMESPACE rollout status deploy/sbx-worker --timeout=600s
kubectl -n $SH_SINGLE_NAMESPACE get route
curl -s "https://moca-control-plane.$SH_ROUTE_DOMAIN/v1/discovery"
```

`/v1/discovery` should report `profile: sandbox`. Once the test below passes, remove the build
objects: `kubectl -n $NS delete bc/moca-cp-sbx is/moca-cp-sbx cm/cp-src-patch`.

**Routes must be admitted** for the client flow to work without plumbing. On a cluster where
`kubectl get route -o jsonpath='{.items[*].status}'` stays empty, the router answers 503 even
though the stack is healthy, and you need `kubectl port-forward` plus a locally trusted exec
certificate instead.

## Deploying to a fresh cluster

As above, minus steps 1 and 2, plus the namespace and a generated secret:

```bash
export KUBECONFIG=<kubeconfig>
export SH_SINGLE_NAMESPACE=moca-sbx
export SH_ROUTE_DOMAIN="$(kubectl get ingresses.config/cluster -o jsonpath='{.spec.domain}')"
kubectl create namespace "$SH_SINGLE_NAMESPACE"
export SH_TEST_USER_SECRET="$(openssl rand -hex 32)"   # save it: the client needs the same value
export SH_IDENTITY_PROVIDER=github
export SH_GITHUB_CLIENT_ID=<github oauth app client id>
export SH_ALLOWED_SUBJECTS=github:<your numeric github id>
export SH_TEST_USERS=1000
export SH_SANDBOX_TEST_USERS_ENROLLED=true
export SH_SANDBOX_COUNT=0
deploy/k8s/setup.sh --target ocp-single --profile sandbox --image "$IMG"
```

`SH_TEST_USER_SECRET` is read by the control plane once at boot from a projected credential, so
changing it later needs a `rollout restart deploy/moca-control-plane`.

## What `--profile sandbox` changes

For sbx plus the harness, use `--profile combined`. Sandbox-only differs in five ways:

- **The supervisor is patched to 0 replicas.** It serves sessions, and this profile mounts none. It
  stays as an object, so switching back to `combined` is a replica change rather than a reinstall.
- **The control plane drops the credential store and the KEK.** That profile refuses to boot with
  them (`SH_CREDENTIAL_KEK` is paired with `SH_EGRESS_HOSTS` — set both or neither), so the
  projected credentials volume is re-listed without them. The harness's token exchange is not
  served here either.
- **Enrollment is the login gate, not just the sandbox gate.** On `combined`, login is open and
  enrollment only decides who may use a sandbox. Here an unenrolled subject cannot log in at all —
  so `SH_SANDBOX_TEST_USERS_ENROLLED=true` is what makes `test:N` usable, and turning it on hands
  every holder of `SH_TEST_USER_SECRET` a working account. Dev and test only. Setting
  `SH_TEST_USERS` while nothing enrols those subjects is **refused at boot** (#1023), naming both
  ways out: without that refusal the login route mounts and answers `not_enrolled` to every call,
  which reads as a broken stack rather than a misconfigured one.
- **The profile is sticky**, like `combined`: a later run with no `--profile` keeps it, and
  switching to `harness` deletes the sandbox objects by name (`kubectl apply -k` does not prune).
- **The session pool defaults to 0.** `SH_SANDBOX_COUNT` defaults to `2` on every other profile;
  here the supervisor is at 0 replicas, so two pool pods would sit Ready and unreachable. On the
  2-core namespace this target is for, that is the difference between fitting and not.

`SH_TEST_USERS` on this profile is [#1023](https://github.com/rossoctl/moca/pull/1023): a released control plane, and #1018
alone, still refuse to boot with it.

## Clusters whose Routes are not admitted

On some clusters every Route's `.status` stays empty — the router admits nothing — so it answers
**503** while the stack itself is perfectly healthy. The installer still succeeds; only the client
path is affected. Everything except `sbx run` then works over one port-forward:

```bash
kubectl -n <ns> port-forward svc/moca-control-plane 18457:8080 &
export MOCACTL_SBX_URL=http://127.0.0.1:18457
```

`sbx run` additionally needs the **exec** path, which the control plane advertises as a Route host
the router will not serve — the symptom is

```
sbx: sandbox failure: UNAVAILABLE: Received HTTP status code 503; the command may have partly run
```

Repoint it at localhost, with a certificate that matches, and restart the two components that read
these at boot:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost" -keyout tls.key -out tls.crt
kubectl -n <ns> create secret tls sbx-exec-tls --cert=tls.crt --key=tls.key \
  --dry-run=client -o yaml | kubectl -n <ns> apply -f -
kubectl -n <ns> patch cm sbx-settings --type merge --patch-file patch.json   # see below
kubectl -n <ns> rollout restart deploy/sandbox-relay deploy/moca-control-plane
kubectl -n <ns> port-forward svc/sbx-relay-exec-tls 8445:8445 &
```

where `patch.json` sets `SH_SANDBOX_EXEC_ENDPOINT` to `localhost:8445` and `SH_SANDBOX_EXEC_CA` to
the PEM just generated — build it with a script rather than inline, since the PEM has newlines:

```python
import json
print(json.dumps({"data": {"SH_SANDBOX_EXEC_ENDPOINT": "localhost:8445",
                           "SH_SANDBOX_EXEC_CA": open("tls.crt").read()}}))
```

`/v1/discovery` should then report `execEndpoint: localhost:8445`, and the client takes the CA from
there, so nothing has to be trusted locally.

**Any later `setup.sh` run puts the Route host back**, along with a certificate for it — that is
problem 7 in reverse, and it is by design: the installer owns the endpoint.

## Testing a test user

Needs no cluster access, provided the cluster's Routes are admitted:

```bash
export MOCA_TEST_USER_SECRET=<the same SH_TEST_USER_SECRET>
export MOCACTL_SBX_URL=https://moca-control-plane.$SH_ROUTE_DOMAIN
export XDG_CONFIG_HOME=$(mktemp -d)        # one profile per test user, for parallel runs
mocactl-dev sbx login --test-user 1000
mocactl-dev sbx create --template default --name tu1000
mocactl-dev sbx run --sandbox tu1000 -- id
mocactl-dev sbx run --sandbox tu1000 -- uname -a
mocactl-dev sbx rm --force tu1000
```

`MOCACTL_SBX_URL` matters beyond `login`: without it every later command fails
`no sandbox control plane` even after a successful login.

Expected: `login` prints the subject `test:1000`, `create` returns a sandbox on worker
`sbx_default`, and both `run` commands execute in the sandbox.

## Problems hit deploying this, and what they look like

Every one of these cost real time on a live cluster. None is a MOCA bug.

**1. A build pod cannot resolve DNS, so the base image never pulls.** In a namespace with a
`default-deny` policy over all pods, the usual blanket allowance (`allow-dns`) permits only
**5353 to `openshift-dns`** — the port the app pods use. A build pod resolves on **53**, so its
lookups are dropped, and a dropped packet looks like a hang:

```
Error: initializing source docker://ghcr.io/rossoctl/moca:<tag>:
pinging container registry ghcr.io: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: i/o timeout
```

Worse, the **first build can succeed anyway** if its base image is already cached on the node it
lands on — that one finished in 23 seconds and hid the problem until a later build scheduled
elsewhere. Add an egress policy scoped to build pods only:

```yaml
spec:
  podSelector:
    matchExpressions:
      - { key: openshift.io/build.name, operator: Exists }
  policyTypes: [Egress]
  egress: [{}]
```

**2. Editing a BuildConfig's Dockerfile `FROM` does not change the base.** If
`spec.strategy.dockerStrategy.from` is set, OpenShift substitutes it and says so in the build log,
one line that is easy to scroll past:

```
Replaced Dockerfile FROM image ghcr.io/rossoctl/moca:main-3b53f15
Pulling image ghcr.io/rossoctl/moca:0.11.0 ...
```

The build then succeeds on the **wrong** base. Patch the field, not the Dockerfile:

```bash
kubectl -n <ns> patch bc <name> --type merge \
  -p '{"spec":{"strategy":{"dockerStrategy":{"from":{"kind":"DockerImage","name":"ghcr.io/rossoctl/moca:main-3b53f15"}}}}}'
```

**3. The base image must be the commit these sources belong to.** Overlaying this branch's three
control-plane files onto an older release produces an image that starts and then dies on a module
the sources import but the image does not have:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/packages/control-plane/src/gate-sweep.js'
  imported from /app/packages/control-plane/src/main.ts
```

`gate-sweep.ts` arrived in `901fea7e`, after 0.11.0. The symptom appears in whichever pod rolls
first — here the **relay**, not the control plane, which made it look like a relay problem.

**4. Neither `readyReplicas` nor `updatedReplicas` tells you a rollout worked.** The old pod keeps
serving a failed rollout, so `readyReplicas=1`; and a pod counts as _updated_ the moment the new
template is applied, whether or not it ever starts. Measured here: a control plane reporting
`spec=1 ready=1 updated=1` while its new pod sat in `CrashLoopBackOff`. Ask for pods that are not
running instead:

```bash
kubectl -n <ns> get deploy <name> -o jsonpath='{.spec.replicas}/{.status.availableReplicas}'
kubectl -n <ns> get pod -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[*].state.waiting.reason}{"\n"}{end}' \
  | grep -iE 'crashloop|error|imagepull'
```

**5. A previous `--profile combined` install leaves an exec Route that blocks the new one.** The
object was `moca-exec`; it is now `sbx-exec` claiming the **same host**, so the new Route is
rejected `HostAlreadyClaimed` and the stale one keeps serving. Delete it first:

```bash
kubectl -n <ns> delete route moca-exec --ignore-not-found
```

**6. Do not read the installer's exit code through a pipe.** `setup.sh ... | tail` reports
**`tail`'s** status, so a failed install looks like `exit 0`. Redirect, then read:

```bash
deploy/k8s/setup.sh ... > install.log 2>&1; echo "EXIT=$?" >> install.log
```

**7. An exec certificate from an earlier install survives, and silently mismatches.** `setup.sh`
keeps an existing `sbx-exec-tls` on purpose — the comment in the teardown path says so, since the
Secret may hold a certificate you supplied. The consequence after a profile change or a domain
change is a stack that advertises one host and presents a certificate for another:

```
sbx-settings SH_SANDBOX_EXEC_ENDPOINT = moca-exec-<ns>.<apps domain>:443
sbx-exec-tls                          = CN=localhost, SAN DNS:localhost
```

Nothing fails at install time; `sbx run` fails TLS verification later. A clean exit is not evidence
the certificate matches, so read it:

```bash
kubectl -n <ns> get secret sbx-exec-tls -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -subject -ext subjectAltName
```

Delete the Secret and re-run the installer to force a reissue. Expect the relay to roll when you
do: its pod template carries a digest of the certificate, precisely so ghostunnel cannot keep
serving the previous one.
