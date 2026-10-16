#!/usr/bin/env bash
# Renders deploy/k8s/overlays/ocp-sbx with the real `kubectl kustomize` (no cluster needed) and
# asserts what SBX0 1a needs: the relay and Redis only, both TLS Routes, the exec listener bound to
# loopback, one namespace. Spec SBX0 §2, §8.1.
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
  Service/sandbox-relay-tls Service/sbx-relay-exec-tls NetworkPolicy/sbx-relay-exec-from-router; do
  has "$o"
done
pass 'renders the relay, Redis, both Routes and their Services'

for o in Deployment/moca-supervisor StatefulSet/moca-sandbox Deployment/moca-control-plane \
  Role/moca-control-plane-credentials RoleBinding/moca-control-plane-credentials; do
  hasnt "$o"
done
pass 'renders no supervisor, sandbox pods, control plane (1b) or credentials Role'

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

grep -A5 -- '- name: MOCA_RELAY_CLIENT_TOKENS' "$OUT" | grep -q 'optional: true' ||
  fail 'MOCA_RELAY_CLIENT_TOKENS is not an optional Secret reference'
pass 'static client tokens come from an optional Secret (1a only)'

awk '/^kind: Route$/,/^---$/' "$OUT" | grep -c 'termination: passthrough' | grep -qx 2 ||
  fail 'both Routes must be passthrough (gRPC must not cross the router TLS termination)'
pass 'both Routes are passthrough'
