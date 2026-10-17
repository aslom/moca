#!/usr/bin/env bash
# Renders deploy/k8s/overlays/ocp-sbx with the real `kubectl kustomize` (no cluster needed) and
# asserts what SBX0 needs: the relay, Redis and the control plane on the sandbox profile, the two
# passthrough Routes and the API's edge Route, the exec listener bound to loopback, the relay on
# sandbox tokens alone, one namespace. Spec SBX0 §2, §3.1, §4.1, §8.1.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
command -v kubectl >/dev/null || { echo "FAIL: kubectl is required (kubectl kustomize)" >&2; exit 1; }
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
kubectl kustomize "$ROOT/deploy/k8s/overlays/ocp-sbx" >"$OUT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# kind/name of every top-level object: kustomize emits apiVersion, kind, metadata in that order, and
# metadata.name is the first 2-space-indented `name:` after a top-level `kind:`.
objects() { awk '/^kind: /{k=$2} /^  name: /{if(k){print k"/"$2; k=""}}' "$OUT"; }
has() { objects | grep -qx "$1" || fail "missing $1"; }
hasnt() { ! objects | grep -qx "$1" || fail "unexpected $1"; }

for o in Deployment/sandbox-relay StatefulSet/redis Route/moca-relay Route/sbx-exec \
  Service/sandbox-relay-tls Service/sbx-relay-exec-tls NetworkPolicy/sbx-relay-exec-from-router \
  Deployment/moca-control-plane Service/moca-control-plane Route/sbx-api \
  NetworkPolicy/moca-control-plane-from-router; do
  has "$o"
done
pass 'renders the relay, Redis, the control plane, the three Routes and their Services'

for o in Deployment/moca-supervisor StatefulSet/moca-sandbox \
  Role/moca-control-plane-credentials RoleBinding/moca-control-plane-credentials; do
  hasnt "$o"
done
pass 'renders no supervisor, sandbox pods or credentials Role'

[[ "$(grep -E '^  namespace: ' "$OUT" | sort -u)" == '  namespace: moca-sbx' ]] ||
  fail "objects outside moca-sbx: $(grep -E '^  namespace: ' "$OUT" | sort -u | tr '\n' ' ')"
pass 'every namespaced object is in the placeholder namespace'

grep -A1 -- '- name: MOCA_RELAY_EXEC_ADDR' "$OUT" | grep -q "value: 127.0.0.1:9444" ||
  fail 'the exec listener is not bound to loopback'
pass 'the exec listener is bound to loopback, so only the sidecar reaches it'

grep -q -- '- 127.0.0.1:9444' "$OUT" || fail 'no sidecar targets the exec listener'
grep -q -- '- 127.0.0.1:9443' "$OUT" || fail 'no sidecar targets the attach listener'
grep -q 'secretName: sbx-exec-tls' "$OUT" || fail 'the exec sidecar does not mount sbx-exec-tls'
pass 'two ghostunnel sidecars: attach -> :9443, exec -> :9444'

# One object (kind/name) of the render, from its `kind:` line to the next `---`.
object() {
  awk -v k="$1" -v n="$2" '
    /^---$/ { if (hit) exit; inobj = 0; next }
    /^kind: / { inobj = ($2 == k); next }
    inobj && /^  name: / { hit = ($2 == n) }
    hit' "$OUT"
}
RELAY="$(object Deployment sandbox-relay)" CP="$(object Deployment moca-control-plane)"
[[ -n "$RELAY" && -n "$CP" ]] || fail 'could not isolate the relay and control-plane Deployments'

! grep -q -- '- name: MOCA_RELAY_CLIENT_TOKENS' "$OUT" || fail 'the 1a static client tokens are still wired'
! grep -q 'MOCA_RELAY_EXEC_TOKEN' <<<"$RELAY" || fail 'the relay still reads a harness exec token'
grep -A4 -- '- name: SH_SANDBOX_TOKEN_PUBLIC_KEYS' <<<"$RELAY" | grep -q 'name: sbx-token-keys' ||
  fail 'the relay does not read the sandbox public keys'
grep -A4 -- '- name: SH_SANDBOX_TOKEN_PUBLIC_KEYS' <<<"$RELAY" | grep -q 'key: PUBLIC_KEYS' ||
  fail 'the relay reads the wrong key of sbx-token-keys'
grep -A4 -- '- name: SH_SANDBOX_TOKEN_ISSUER' <<<"$RELAY" | grep -q 'name: sbx-settings' ||
  fail 'the relay does not read the sandbox token issuer (it refuses to boot without one)'
grep -A4 -- '- name: SH_SANDBOX_MAX_INFLIGHT' <<<"$RELAY" | grep -q 'key: SH_SANDBOX_MAX_INFLIGHT' ||
  fail 'the relay does not read the in-flight cap from sbx-settings'
pass 'the relay takes sandbox tokens and nothing else (no exec token, no static client tokens)'

grep -A1 -- '- name: SH_ROUTE_PROFILE' <<<"$CP" | grep -q 'value: sandbox' || fail 'control plane not on the sandbox profile'
for k in SH_CREDENTIAL_STORE SH_CREDENTIAL_NAMESPACE SH_SANDBOX_NAMESPACE SH_SANDBOX_TIERS \
  SH_SANDBOX_DEFAULT_TIER SH_PUBLIC_HARNESS_URL SH_ALLOW_OPERATOR_FALLBACK SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN; do
  ! grep -q "$k" <<<"$CP" || fail "the control plane still configures $k"
done
for k in SH_ALLOWED_SUBJECTS SH_SANDBOX_TEMPLATES SH_SANDBOX_EXEC_ENDPOINT SH_SANDBOX_EXEC_CA \
  SH_SANDBOX_TOKEN_ISSUER SH_SANDBOX_LIFETIME_SECONDS SH_SANDBOX_TOKEN_TTL_SECONDS SH_SANDBOX_RETENTION_SECONDS \
  SH_SANDBOX_MAX_PER_SUBJECT SH_SANDBOX_MAX_TOTAL; do
  grep -A4 -- "- name: $k\$" <<<"$CP" | grep -q 'name: sbx-settings' || fail "the control plane does not read $k from sbx-settings"
done
grep -A5 -- '- name: SH_SANDBOX_EXEC_CA$' <<<"$CP" | grep -q 'optional: true' ||
  fail 'SH_SANDBOX_EXEC_CA must be optional (absent when the exec certificate is issued)'
grep -q 'key: SH_SESSION_TOKEN_PRIVATE_KEY' <<<"$CP" || fail 'the control plane does not mount its signing key'
grep -q 'automountServiceAccountToken: false' <<<"$CP" || fail 'the control plane still mounts a service account token'
pass 'the control plane runs the sandbox profile with only its signing key mounted'

# The policy's spec.ingress block alone: its `ingress:` line up to the next spec key.
cp_ingress="$(object NetworkPolicy moca-control-plane | awk '/^  ingress:/ { f = 1; print; next } f && /^  [a-z]/ { f = 0 } f')"
[[ -n "$cp_ingress" ]] || fail 'the base control-plane policy has no ingress field to check'
! grep -q 'podSelector' <<<"$cp_ingress" ||
  fail "the base control-plane policy still admits the supervisor"
object NetworkPolicy moca-control-plane-from-router | grep -q 'policy-group.network.openshift.io/ingress' ||
  fail 'the router may not reach the control plane'
pass 'only the router reaches the control plane'

# The sandbox profile calls no Kubernetes API (no credential store, no service account token), so its
# egress is Redis and 443 (GitHub's device flow) only: the base's 6443 (kube API after DNAT) is dropped.
cp_policy="$(object NetworkPolicy moca-control-plane)"
grep -q 'port: 443$' <<<"$cp_policy" || fail 'the control plane lost its 443 egress (GitHub device flow)'
grep -q 'port: 6379$' <<<"$cp_policy" || fail 'the control plane lost its Redis egress'
! grep -q 'port: 6443' <<<"$cp_policy" || fail 'the sandbox control plane still has 6443 (Kubernetes API) egress'
pass 'the control plane has no Kubernetes API egress (6443)'

awk '/^kind: Route$/,/^---$/' "$OUT" | grep -c 'termination: edge' | grep -qx 1 || fail 'want one edge Route (the API)'
object Route sbx-api | grep -q 'name: moca-control-plane' || fail 'the API Route does not target the control plane'
pass 'the API Route is edge-terminated, to the control plane'

awk '/^kind: Route$/,/^---$/' "$OUT" | grep -c 'termination: passthrough' | grep -qx 2 ||
  fail 'the attach and exec Routes must be passthrough (gRPC must not cross the router TLS termination)'
pass 'the attach and exec Routes are passthrough'
