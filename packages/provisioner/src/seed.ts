/**
 * Seeding a workload's PVC (workload sandboxes spec §5.2, §5.3). The worker hands the provisioner
 * the frozen bundle it downloaded from Context Service's export; the provisioner holds it here, in
 * memory and within MOCA_PROVISIONER_SEED_BUDGET_BYTES across all workloads, until pod `<wl>-0`'s
 * init containers have seeded the claim. They fetch it from the seed port with the workload's attach
 * token, whose `wl` and `gen` pick the bundle. A provisioner restart before the seed loses it: the
 * seed port answers 404 seed_bundle_missing, the GET reports it, and the worker's next activate
 * sends it again.
 */

export interface HeldBundle {
  /** The generation it was handed over for: a token of another generation never fetches it. */
  gen: string;
  bytes: Buffer;
  /** Epoch seconds it was handed over. */
  at: number;
}

export class BundleStore {
  private held = new Map<string, HeldBundle>();
  private bytes = 0;

  /** MOCA_PROVISIONER_SEED_BUDGET_BYTES: every held bundle together. */
  constructor(readonly budget: number) {}

  /** Hold `bundle` for `wl`, replacing an earlier one. False when it does not fit the budget. */
  put(wl: string, bundle: HeldBundle): boolean {
    const previous = this.held.get(wl)?.bytes.length ?? 0;
    if (this.bytes - previous + bundle.bytes.length > this.budget) return false;
    this.bytes += bundle.bytes.length - previous;
    this.held.set(wl, bundle);
    return true;
  }

  get(wl: string): HeldBundle | undefined {
    return this.held.get(wl);
  }

  drop(wl: string): void {
    const b = this.held.get(wl);
    if (!b) return;
    this.bytes -= b.bytes.length;
    this.held.delete(wl);
  }

  entries(): [string, HeldBundle][] {
    return [...this.held];
  }

  get heldBytes(): number {
    return this.bytes;
  }
}

/** Where each init container mounts what it seeds (spec §5.3: neither mounts the claim root). */
export const SEED_REVISION_DIR = '/seed/revision';
export const SEED_WORKSPACE_DIR = '/seed/workspace';

/** Both scripts: nothing without the annotation; ORDINAL is the pod's, from its name. */
const PREAMBLE = [
  'set -euo pipefail',
  '[ -n "${SEED_REVISION:-}" ] || { echo "seed: no moca.dev/seed-revision, nothing to do"; exit 0; }',
  `[[ "$SEED_REVISION" =~ ^[a-f0-9]{64}$ ]] || { echo "seed: bad revision" >&2; exit 1; }`,
  'ORDINAL="${POD_NAME##*-}"',
];

/**
 * The first init container. It mounts `subPath: revision` read-write and nothing of
 * `moca-workspace`. Only pod `<wl>-0` writes (spec §5.3), so there is one writer and no lock; every
 * other pod waits until `revision/<rev>` exists, then exits 0. In pod 0: an existing
 * `revision/<rev>` is a finished seed, since it only ever appears by the rename below. Otherwise it
 * refuses anything in `revision/` but its own leftover temp dirs, which it removes; fetches the
 * bundle with the attach token; refuses one over MAX_ENTRIES entries; extracts it into a fresh
 * `mktemp` dir; removes write permission; and renames it into place, so a crash never leaves a
 * half-seeded tree under the revision's name.
 */
export const SEED_REVISION_SCRIPT = [
  ...PREAMBLE,
  `cd ${SEED_REVISION_DIR}`,
  'if [ "$ORDINAL" != 0 ]; then',
  '  until [ -d "$SEED_REVISION" ]; do echo "seed: waiting for pod 0 to seed revision $SEED_REVISION"; sleep 2; done',
  '  exit 0',
  'fi',
  '[ ! -d "$SEED_REVISION" ] || { echo "seed: revision $SEED_REVISION already seeded"; exit 0; }',
  'for e in * .[!.]* ..?*; do',
  '  [ -e "$e" ] || [ -L "$e" ] || continue',
  '  case "$e" in .seed-*) ;; *) echo "seed: refusing: revision/ holds $e" >&2; exit 1 ;; esac',
  'done',
  'chmod -R u+w .seed-* 2>/dev/null || true; rm -rf .seed-*',
  'T="$(mktemp -d .seed-XXXXXX)"',
  'trap \'chmod -R u+w "$T" 2>/dev/null || true; rm -rf "$T" "$T.bundle"\' EXIT',
  // -f: a 404 seed_bundle_missing (a provisioner restart) fails the container until a resend.
  'curl -fsS --max-time 600 -H "authorization: Bearer $(cat "$SANDBOX_TOKEN_FILE")" -o "$T.bundle" "$SEED_URL"',
  'ENTRIES="$(tar -tzf "$T.bundle" | wc -l)"',
  '[ "$ENTRIES" -le "$MAX_ENTRIES" ] || { echo "seed: bundle has $ENTRIES entries, over $MAX_ENTRIES" >&2; exit 1; }',
  'tar -xzf "$T.bundle" --no-same-owner --no-same-permissions -C "$T"',
  'rm -f "$T.bundle"',
  // `X` keeps every directory traversable; files keep their exec bits.
  'chmod -R u+rX,a-w "$T"',
  // Absent, checked above, so this is a rename and never a move into it.
  'mv "$T" "$SEED_REVISION"',
  'trap - EXIT',
  'echo "seed: revision $SEED_REVISION seeded ($ENTRIES entries)"',
].join('\n');

/**
 * The second init container, for a writable mount only. It mounts `subPath: revision/<rev>`
 * read-only and `subPath: moca-workspace` read-write, so a symlink planted in the workspace resolves
 * inside its own mounts, never into `revision/`. Other pods than `<wl>-0` wait until the workspace
 * is seeded (it holds no temp dir and is not empty, unless the revision is), then exit 0 without
 * writing. In pod 0 it refuses to seed when `moca-workspace` holds anything but its own leftover
 * temp dirs: that tree is model code's, so a finished seed (or the workload) already filled it. It
 * copies the revision into a fresh temp dir (`cp -a` copies symlinks, never follows them), makes it
 * writable, renames it to `.moca-seed-ready`, and moves its entries into place. The mount point
 * cannot itself be renamed onto, so a crash during those moves leaves `.moca-seed-ready`, and the
 * next run finishes the moves instead of starting again.
 */
export const SEED_WORKSPACE_SCRIPT = [
  ...PREAMBLE,
  `cd ${SEED_WORKSPACE_DIR}`,
  'if [ "$ORDINAL" != 0 ]; then',
  `  until [ -z "$(find . -mindepth 1 -maxdepth 1 -name '.moca-seed-*' -print -quit)" ] &&`,
  `    { [ -n "$(ls -A .)" ] || [ -z "$(ls -A ${SEED_REVISION_DIR})" ]; }; do`,
  '    echo "seed: waiting for pod 0 to seed moca-workspace"; sleep 2',
  '  done',
  '  exit 0',
  'fi',
  'if [ ! -d .moca-seed-ready ] || [ -L .moca-seed-ready ]; then',
  '  for e in * .[!.]* ..?*; do',
  '    [ -e "$e" ] || [ -L "$e" ] || continue',
  '    case "$e" in .moca-seed-*) ;; *) echo "seed: moca-workspace is not empty, not seeding it"; exit 0 ;; esac',
  '  done',
  '  chmod -R u+w .moca-seed-* 2>/dev/null || true; rm -rf .moca-seed-*',
  '  T="$(mktemp -d .moca-seed-XXXXXX)"',
  `  cp -a ${SEED_REVISION_DIR}/. "$T"/`,
  '  chmod -R u+w "$T"',
  '  mv "$T" .moca-seed-ready',
  'fi',
  "find .moca-seed-ready -mindepth 1 -maxdepth 1 -exec mv {} . ';'",
  'rmdir .moca-seed-ready',
  'echo "seed: moca-workspace seeded from revision $SEED_REVISION"',
].join('\n');
