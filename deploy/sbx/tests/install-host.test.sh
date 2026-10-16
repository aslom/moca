#!/usr/bin/env bash
# Tests for deploy/sbx/install-host.sh with systemctl and journalctl mocked: what it writes, that
# two workers never share a slice, jail or workspace root (SBX0 §8.2), and that --uninstall leaves
# workspace data alone.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }

cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
[[ "$1" == show ]] && { echo "InvocationID=abc123"; exit 0; }
exit 0
MOCK
cat >"$TMP/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >>"$MOCK_LOG"
[[ -n "${MOCK_NO_ATTACH:-}" ]] || echo 'microvm-worker: attached, serving execs'
MOCK
chmod +x "$TMP/bin/systemctl" "$TMP/bin/journalctl"
export PATH="$TMP/bin:$PATH" SBX_UNIT_DIR="$TMP/units" SBX_ENV_DIR="$TMP/etc" SBX_SRV="$TMP/srv"
export SBX_SKIP_ROOT_CHECK=1 SBX_ATTACH_TIMEOUT=2 SBX_ATTACH_SETTLE=1
INSTALL="$SRC/deploy/sbx/install-host.sh"
mkdir -p "$SBX_SRV/snapshots/default" "$SBX_SRV/snapshots/py312"

bundle() { # bundle ID
  local d="$TMP/bundles/$1"
  mkdir -p "$d"
  printf 'RELAY_ADDR=sbx-attach.apps.example.invalid:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n' \
    "$1" "$(printf '%064d' 7)" >"$d/worker.env"
  printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' >"$d/relay-ca.crt"
  echo "$d"
}

# Refusals
! bash "$INSTALL" "$(bundle sbx_default)" >"$TMP/out" 2>&1 || fail 'installed without --snapshot'
! bash "$INSTALL" "$(bundle sbx_default)" --snapshot missing >"$TMP/out" 2>&1 || fail 'installed a missing snapshot'
grep -q 'no snapshot' "$TMP/out" || fail 'missing-snapshot refusal does not say why'
b="$(bundle sbx_bad)"; sed -i.bak 's/^SANDBOX_TOKEN=.*/SANDBOX_TOKEN=short/' "$b/worker.env"
! bash "$INSTALL" "$b" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted a malformed token'
! grep -q 'short' "$TMP/out" || fail 'the refusal printed the token value'
pass 'refuses a missing snapshot, a missing --snapshot and a malformed token (without printing it)'

bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'install sbx_default'
bash "$INSTALL" "$(bundle sbx_py312)" --snapshot py312 --budget-mb 8192 >"$TMP/out" 2>&1 || fail 'install sbx_py312'

A="$SBX_ENV_DIR/workers/sbx_default.env" B="$SBX_ENV_DIR/workers/sbx_py312.env"
for f in "$A" "$B"; do
  [[ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" == 600 ]] || fail "$f is not 0600"
  grep -qx 'SH_WORKSPACE_IDLE=216h' "$f" || fail "$f: SH_WORKSPACE_IDLE is not 216h"
  grep -qx 'RELAY_TLS=true' "$f" || fail "$f: RELAY_TLS"
done
grep -qx 'SH_SNAPSHOT_IMAGE=py312' "$B" || fail 'snapshot not set'
grep -qx 'SH_MAX_COMMITTED_MB=8192' "$B" || fail 'budget not set'
for k in SH_PARENT_CGROUP SH_CHROOT_BASE SH_WORKSPACE_ROOT; do
  va="$(grep "^$k=" "$A" | cut -d= -f2-)" vb="$(grep "^$k=" "$B" | cut -d= -f2-)"
  [[ -n "$va" && "$va" != "$vb" ]] || fail "$k is shared between workers ($va)"
done
grep -qx 'SH_PARENT_CGROUP=sbx.slice/sbx-sbx_py312.slice' "$B" || fail 'parent cgroup is not the worker slice'
pass 'two workers: 0600 env files, own slice, jail and workspace root, 9-day idle'

[[ -f "$SBX_UNIT_DIR/sbx-worker@.service" && -f "$SBX_UNIT_DIR/sbx.slice" ]] || fail 'template unit or parent slice missing'
[[ -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] || fail 'per-worker slice missing'
grep -qx 'Slice=sbx-%i.slice' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit is not in its worker slice'
grep -qx 'AssertPathExists=/dev/kvm' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks AssertPathExists=/dev/kvm'
grep -qx 'StartLimitIntervalSec=300' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks StartLimitIntervalSec=300'
grep -qx 'StartLimitBurst=5' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks StartLimitBurst=5'
grep -q 'systemctl enable --now sbx-worker@sbx_py312.service' "$MOCK_LOG" || fail 'unit not enabled'
grep -q 'sbx-worker@sbx_py312' "$SBX_ENV_DIR/manifest" || fail 'manifest does not record the worker'
pass 'installs the template unit, the slices, enables the worker and records it'

: >"$MOCK_LOG"
! MOCK_NO_ATTACH=1 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'reported success with no attach'
grep -q 'journalctl -u sbx-worker@sbx_default' "$TMP/out" || fail 'no-attach failure does not name the journal'
pass 'fails, naming the journal, when the worker never logs an attach'

mkdir -p "$SBX_SRV/workspaces/sbx_py312/sbx-keepme"
bash "$INSTALL" --uninstall sbx_py312 >"$TMP/out" 2>&1 || fail 'uninstall'
grep -q 'systemctl disable --now sbx-worker@sbx_py312.service' "$MOCK_LOG" || fail 'unit not disabled'
[[ ! -f "$B" && ! -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] || fail 'env file or slice kept'
[[ -d "$SBX_SRV/workspaces/sbx_py312/sbx-keepme" ]] || fail 'uninstall removed workspace data'
grep -q "left in place: $SBX_SRV/workspaces/sbx_py312" "$TMP/out" || fail 'uninstall does not say what it kept'
pass '--uninstall stops and removes the worker, keeps (and names) its workspace data'
