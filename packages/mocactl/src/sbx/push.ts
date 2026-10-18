import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { MAX_STDIN_BYTES, q, WORKSPACE, type Exec, type ExecResult } from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import { BINDING_URL_RE, SANDBOX_ID_RE } from './state.js';
import { PY_TAR_EXTRACT, tarEntries, type TarEntry } from './tar.js';

/**
 * Code in, patch out (SBX0 spec §6.2). The sandbox is the workspace: the working tree goes in as
 * tar chunks, a baseline is committed inside the sandbox, and what the agent changed comes back as
 * a `git diff` against it. Nothing here writes the laptop's tree except `applyPatch`.
 */
export const CHUNK_TARGET = 8 << 20;
export const MAX_FILE = 12 << 20;
/** No Exec's stdin exceeds it: sandbox-client's own ceiling (the gRPC message is 16 MiB). */
export const MAX_STDIN = MAX_STDIN_BYTES;
export const DEFAULT_MAX_PUSH = 256 << 20;
export const BUILD_EXCLUDES = [
  '__pycache__/',
  '*.pyc',
  'node_modules/',
  '.venv/',
  'venv/',
  '.pytest_cache/',
  '.mypy_cache/',
  'dist/',
  'build/',
  'target/',
] as const;
/**
 * What the sandbox never records, beyond BUILD_EXCLUDES: `.sbx/` is the laptop's binding, so an
 * agent's `.sbx/sandbox.json` must never come back in a patch and repoint it.
 */
const SANDBOX_EXCLUDES = [...BUILD_EXCLUDES, '.sbx/', '/lost+found/'];
const SECRET_RE = /^(\.env.*|.*\.pem|.*\.key|id_.*)$/;
/** Each push or pull Exec: a fresh VM extracting at most 14 MiB, or one git command. */
export const SYNC_TIMEOUT_S = 300;
/** Marks a push that has emptied the workspace but not yet committed its baseline. */
const INCOMPLETE = '.git/sbx-push-incomplete';
/**
 * The baseline: a ref of its own, not HEAD, so an agent that commits (or resets) in the sandbox
 * cannot hide its work from `pull` or have it discarded by `push`.
 */
export const BASELINE_REF = 'refs/sbx/baseline';
/** A scratch index: the sandbox's own index (the agent's) is never changed by push or pull. */
const SCRATCH = '.git/sbx-index';

export class PushError extends Error {}

const run = promisify(execFile);
async function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const p = run('git', args, { cwd, encoding: 'buffer', maxBuffer: 512 << 20 });
  if (input) p.child.stdin?.end(input);
  return (await p).stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).toString().trim();
    if (!top) throw new Error('no work tree');
    return top;
  } catch {
    throw new PushError('not inside a git repository: run sbx up, push and pull from your project');
  }
}

/** sha256(origin URL, else the root path)[:16]: the `project` label `sbx up` finds sandboxes by. */
export async function repoId(root: string): Promise<string> {
  let origin = '';
  try {
    origin = (await git(root, ['remote', 'get-url', 'origin'])).toString().trim();
  } catch {
    origin = '';
  }
  return createHash('sha256')
    .update(origin || root)
    .digest('hex')
    .slice(0, 16);
}

export interface PushPlan {
  /** gzip tars, each at most MAX_STDIN, extracted in order. */
  chunks: Buffer[];
  /** What the baseline must contain: every pushed path. */
  paths: string[];
  files: number;
  /** Uncompressed bytes of file content. */
  bytes: number;
  excludedSecrets: string[];
  skipped: string[];
}

const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;

/** The NUL-separated names of `git ls-files -z`, refusing any that would not survive as UTF-8. */
function splitNames(raw: Buffer): string[] {
  const out: string[] = [];
  const bad: string[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i < raw.length && raw[i] !== 0) continue;
    if (i > start) {
      const b = raw.subarray(start, i);
      const s = b.toString('utf8');
      if (Buffer.from(s, 'utf8').equals(b)) out.push(s);
      else bad.push(JSON.stringify(s));
    }
    start = i + 1;
  }
  if (bad.length) {
    throw new PushError(
      `file names that are not valid UTF-8 cannot be pushed (rename them): ${bad.join(', ')}`,
    );
  }
  return out;
}

function lstatOrGone(p: string): Stats | undefined {
  try {
    return lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined; // deleted, still in the index
    throw err;
  }
}

/** What a tar member costs: its header, a PAX record if any, and its padded data. */
const memberBytes = (path: string, size: number) =>
  512 + Math.ceil(size / 512) * 512 + (Buffer.byteLength(path) > 100 ? 1024 + path.length : 512);

/**
 * The push (SBX0 §6.2): `git ls-files --cached --others --exclude-standard`, so tracked files (even
 * under an ignored directory) and untracked ones that are not ignored. Refused, before anything is
 * sent: a file over MAX_FILE (by name), a tree over `maxPush` (with its largest directories).
 */
export async function planPush(
  root: string,
  o: { includeSecrets?: boolean; maxPush?: number } = {},
): Promise<PushPlan> {
  const raw = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const names = [...new Set(splitNames(raw).map((n) => n.replace(/\/$/, '')))];
  const excludedSecrets: string[] = [];
  const skipped: string[] = [];
  const tooBig: string[] = [];
  const byTop = new Map<string, number>();
  const kept: { path: string; st: Stats }[] = [];
  let bytes = 0;
  for (const p of names) {
    if (p === '.sbx' || p.startsWith('.sbx/')) continue; // the binding is the laptop's
    if (!o.includeSecrets && SECRET_RE.test(posix.basename(p))) {
      excludedSecrets.push(p);
      continue;
    }
    const st = lstatOrGone(join(root, p));
    if (!st) continue;
    if (st.isDirectory()) {
      skipped.push(`${p} (a submodule or nested repository: not pushed)`);
      continue;
    }
    if (!st.isFile() && !st.isSymbolicLink()) {
      skipped.push(`${p} (not a file or symlink: not pushed)`);
      continue;
    }
    if (st.isFile()) {
      if (st.size > MAX_FILE) tooBig.push(`${p} (${mib(st.size)})`);
      bytes += st.size;
      const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : '.';
      byTop.set(top, (byTop.get(top) ?? 0) + st.size);
    }
    kept.push({ path: p, st });
  }
  if (tooBig.length) {
    throw new PushError(
      `files over ${MAX_FILE >> 20} MiB are not pushed; remove them, or .gitignore them: ${tooBig.join(', ')}`,
    );
  }
  const max = o.maxPush ?? DEFAULT_MAX_PUSH;
  if (bytes > max) {
    const largest = [...byTop]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k === '.' ? '(top-level files)' : `${k}/`} ${mib(v)}`);
    throw new PushError(
      `the tree is ${mib(bytes)}, over the ${mib(max)} limit (--max-push); largest: ${largest.join(', ')}`,
    );
  }
  const chunks: Buffer[] = [];
  let cur: TarEntry[] = [];
  let curBytes = 0;
  const flush = () => {
    if (!cur.length) return;
    const gz = gzipSync(tarEntries(cur));
    if (gz.length > MAX_STDIN) {
      // Only a file that grew past MAX_FILE since it was measured can get here.
      throw new PushError('a file changed size while the push was being packed: run it again');
    }
    chunks.push(gz);
    cur = [];
    curBytes = 0;
  };
  for (const { path, st } of kept) {
    const abs = join(root, path);
    const mtime = Math.floor(st.mtimeMs / 1000);
    const e: TarEntry = st.isSymbolicLink()
      ? { path, type: 'symlink', mode: 0o777, linkname: readlinkSync(abs), mtime }
      : {
          path,
          type: 'file',
          mode: st.mode & 0o111 ? 0o755 : 0o644,
          data: readFileSync(abs),
          mtime,
        };
    const size = memberBytes(path, e.data?.length ?? 0);
    if (curBytes + size > CHUNK_TARGET) flush();
    cur.push(e);
    curBytes += size;
  }
  flush();
  if (!chunks.length) chunks.push(gzipSync(tarEntries([])));
  return {
    chunks,
    paths: kept.map((k) => k.path),
    files: kept.length,
    bytes,
    excludedSecrets,
    skipped,
  };
}

/**
 * git with nothing of the environment's configuration that would change what is recorded: no
 * hooks, no signing, no line-ending conversion, and any owner (the workspace may be another uid's).
 */
const G = `git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c core.autocrlf=false -c ${q('safe.directory=*')}`;
const ID = '-c user.name=sbx -c user.email=sbx@localhost';

const EXTRACT =
  // GNU tar's -z runs gzip: without it, Python's tarfile (which has its own).
  'if command -v tar >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1; then tar -xzf - --no-same-owner; ' +
  `else python3 -c ${q(PY_TAR_EXTRACT)}; fi`;

/** Empties the workspace (lost+found, a filesystem's own, stays), read-only directories included. */
const EMPTY =
  '{ find . -mindepth 1 -path ./lost+found -prune -o ! -type l ! -perm -200 -exec chmod u+w {} + 2>/dev/null || true; } && ' +
  'find . -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf -- {} +';

/**
 * The sandbox's state in `$s` (and, for `clean`/`dirty`, the baseline commit in `$b` and the
 * workspace's current tree in `$t`):
 * - `clean`: the workspace is the baseline;
 * - `dirty`: changes not yet pulled: the workspace's tree (the baseline's entries, then `add -A`,
 *   in a scratch index with no stat data, so every file is hashed and no mtime can hide an edit)
 *   is not the baseline's. A superset of a non-empty `git status --porcelain`
 *   (SBX0 §6.2) that also counts work the agent committed;
 * - `empty`: never pushed, nothing there;
 * - `no_baseline`: files, but no baseline (put there by hand, or the agent removed .git): never
 *   discarded unasked;
 * - `incomplete`: a push emptied the workspace and did not finish.
 */
const STATE =
  `if [ -e ${INCOMPLETE} ]; then s=incomplete; ` +
  `elif [ ! -d .git ] || ! b=$(${G} rev-parse -q --verify ${q(`${BASELINE_REF}^{commit}`)} 2>/dev/null); then ` +
  'if [ -n "$(find . -mindepth 1 -maxdepth 1 ! -name lost+found ! -name .git | head -n 1)" ]; then s=no_baseline; else s=empty; fi; ' +
  `else rm -f ${SCRATCH} && GIT_INDEX_FILE=${SCRATCH} ${G} read-tree "$b" && ` +
  `GIT_INDEX_FILE=${SCRATCH} ${G} add -A && t=$(GIT_INDEX_FILE=${SCRATCH} ${G} write-tree) || exit 1; ` +
  `rm -f ${SCRATCH}; ` +
  `if [ "$t" = "$(${G} rev-parse "$b^{tree}")" ]; then s=clean; else s=dirty; fi; fi`;

export type SandboxState = 'clean' | 'dirty' | 'empty' | 'no_baseline' | 'incomplete';

interface SyncOpts {
  signal?: AbortSignal;
}

function outcome(r: ExecResult): string {
  if (r.timedOutS !== undefined) return `timed out after ${r.timedOutS}s`;
  if (r.exitCode < 0) return 'was killed (out of memory, or a signal)';
  const err = sanitizeRemote(r.stderr.toString()).trim().split('\n').slice(-5).join('\n');
  return err || `exit ${r.exitCode}`;
}

async function must(
  exec: Exec,
  command: string,
  what: string,
  o: SyncOpts & { stdin?: Buffer } = {},
): Promise<ExecResult> {
  const r = await exec(command, {
    ...(o.stdin ? { stdin: o.stdin } : {}),
    timeoutS: SYNC_TIMEOUT_S,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (r.exitCode !== 0) throw new PushError(`${what} failed in the sandbox: ${outcome(r)}`);
  return r;
}

/** NUL-separated paths, cut into slices of at most `max` bytes at name boundaries. */
function pathSlices(paths: string[], max: number): Buffer[] {
  const out: Buffer[] = [];
  let cur: Buffer[] = [];
  let n = 0;
  for (const p of paths) {
    const b = Buffer.from(`${p}\0`, 'utf8');
    if (n + b.length > max && cur.length) {
      out.push(Buffer.concat(cur));
      cur = [];
      n = 0;
    }
    cur.push(b);
    n += b.length;
  }
  out.push(Buffer.concat(cur));
  return out;
}

/** `git add -f` of exactly these paths (stdin), literally: a name is never a glob or a magic. */
const ADD_LISTED = `${G} --literal-pathspecs add -f --pathspec-from-file=- --pathspec-file-nul`;

/**
 * Empties the workspace, extracts every chunk, and commits the baseline: `git add -A`, then the
 * pushed list forced in (R6b), so a tracked file under an ignored directory is in the baseline and
 * an agent's edit of it comes back in the patch.
 */
export async function pushTree(
  exec: Exec,
  plan: PushPlan,
  ws = WORKSPACE,
  o: SyncOpts & { onChunk?: (i: number, n: number) => void } = {},
): Promise<void> {
  const cd = `cd ${q(ws)}`;
  const n = plan.chunks.length;
  for (const [i, c] of plan.chunks.entries()) {
    o.onChunk?.(i + 1, n);
    const start =
      i === 0
        ? `${EMPTY} && ${G} init -q && mkdir -p .git/info && : > ${INCOMPLETE} && ` +
          `printf '%s\\n' ${SANDBOX_EXCLUDES.map(q).join(' ')} > .git/info/exclude && `
        : `{ [ -e ${INCOMPLETE} ] || { echo 'the push was interrupted (another push to this sandbox?)' >&2; exit 1; }; } && `;
    await must(exec, `${cd} && ${start}${EXTRACT}`, `the push (part ${i + 1} of ${n})`, {
      ...o,
      stdin: c,
    });
  }
  const lists = pathSlices(plan.paths, MAX_STDIN);
  for (const l of lists.slice(0, -1)) {
    await must(exec, `${cd} && ${ADD_LISTED}`, 'recording the baseline', { ...o, stdin: l });
  }
  await must(
    exec,
    `${cd} && ${G} add -A && ${ADD_LISTED} && ` +
      `${G} ${ID} commit -q --no-verify --allow-empty -m sbx-baseline && ` +
      `${G} update-ref ${BASELINE_REF} HEAD && rm -f ${INCOMPLETE}`,
    'the baseline commit',
    { ...o, stdin: lists.at(-1)! },
  );
}

export async function sandboxState(
  exec: Exec,
  ws = WORKSPACE,
  o: SyncOpts = {},
): Promise<SandboxState> {
  const r = await must(exec, `cd ${q(ws)} && ${STATE} && echo "$s"`, 'checking for changes', o);
  const s = r.stdout.toString().trim();
  if (!['clean', 'dirty', 'empty', 'no_baseline', 'incomplete'].includes(s)) {
    throw new PushError(`checking for changes: unexpected answer from the sandbox`);
  }
  return s as SandboxState;
}

/**
 * Whether the sandbox holds work a push would discard: changes since the baseline, or files with
 * no baseline at all. An unfinished push holds none (it emptied the workspace first).
 */
export async function hasUnpulled(exec: Exec, ws = WORKSPACE, o: SyncOpts = {}): Promise<boolean> {
  const s = await sandboxState(exec, ws, o);
  return s === 'dirty' || s === 'no_baseline';
}

const TREE_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NO_BASELINE = 3;
/** Stops a command unless the state is clean or dirty, naming the state on stderr. */
const NEED_BASELINE = `case "$s" in clean|dirty) ;; *) echo "sbx-state:$s" >&2; exit ${NO_BASELINE};; esac`;

function noBaseline(r: ExecResult): PushError | undefined {
  const s = /sbx-state:(\w+)/.exec(r.stderr.toString())?.[1];
  if (r.exitCode !== NO_BASELINE || !s) return undefined;
  return new PushError(
    s === 'incomplete'
      ? 'the last push to the sandbox did not finish: run mocactl sbx push'
      : 'the sandbox has no baseline to diff against (it was never pushed, or its .git was removed): ' +
          'run mocactl sbx push --force to replace what is there, or fetch files with mocactl sbx run',
  );
}

/**
 * The agent's changes: the binary diff from the baseline to the workspace as it is now, and that
 * tree's id (for `advanceBaseline`). Refused when stdout was cut at the worker's 8 MiB cap: a cut
 * patch is never returned (spec §10.3).
 */
export async function capture(
  exec: Exec,
  ws = WORKSPACE,
  o: SyncOpts = {},
): Promise<{ patch: Buffer; tree: string }> {
  const command =
    `cd ${q(ws)} && ${STATE} && ${NEED_BASELINE} && printf '%s\\n' "$t" && ` +
    `${G} diff --binary --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ "$b" "$t"`;
  const r = await exec(command, {
    timeoutS: SYNC_TIMEOUT_S,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const nb = noBaseline(r);
  if (nb) throw nb;
  if (r.exitCode !== 0) {
    throw new PushError(`capturing the patch failed in the sandbox: ${outcome(r)}`);
  }
  if (r.truncated) {
    throw new PushError(
      "the sandbox's changes are over 8 MiB as a patch, more than one Exec returns, so nothing was " +
        'pulled; pull them in parts: mocactl sbx run -- git diff --binary sbx/baseline -- PATH ...',
    );
  }
  const nl = r.stdout.indexOf(0x0a);
  const tree = nl > 0 ? r.stdout.subarray(0, nl).toString() : '';
  if (!TREE_RE.test(tree)) {
    throw new PushError('capturing the patch: unexpected answer from the sandbox');
  }
  return { patch: r.stdout.subarray(nl + 1), tree };
}

export async function capturePatch(exec: Exec, ws = WORKSPACE, o: SyncOpts = {}): Promise<Buffer> {
  return (await capture(exec, ws, o)).patch;
}

/**
 * Makes what was pulled the sandbox's baseline, so the next pull holds only newer changes (spec
 * §6.2). With `tree` (from `capture`), exactly that tree, so a change the agent made after the
 * capture is still pulled next time; without, the workspace as it is now. HEAD follows when the
 * agent has not moved it (so its own `git diff` shows only unpulled work); the agent's own commits
 * and the files in the workspace are never touched.
 */
export async function advanceBaseline(
  exec: Exec,
  ws = WORKSPACE,
  tree?: string,
  o: SyncOpts = {},
): Promise<void> {
  if (tree !== undefined && !TREE_RE.test(tree)) throw new PushError(`not a tree id: ${tree}`);
  const command =
    `cd ${q(ws)} && ${STATE} && ${NEED_BASELINE} && ` +
    (tree ? `t=${tree} && ` : '') +
    `c=$(${G} ${ID} commit-tree "$t" -p "$b" -m sbx-pulled) && ` +
    `${G} update-ref ${BASELINE_REF} "$c" "$b" && ` +
    `if [ "$(${G} rev-parse -q --verify HEAD)" = "$b" ]; then ${G} update-ref HEAD "$c" "$b" && ${G} reset -q; fi`;
  const r = await exec(command, {
    timeoutS: SYNC_TIMEOUT_S,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const nb = noBaseline(r);
  if (nb) throw nb;
  if (r.exitCode !== 0)
    throw new PushError(`advancing the baseline failed in the sandbox: ${outcome(r)}`);
}

/** The paths a patch touches (both sides of a rename), from `git apply --numstat -z`. */
async function patchPaths(root: string, file: string): Promise<string[]> {
  let raw: Buffer;
  try {
    raw = await git(root, ['apply', '--numstat', '-z', file]);
  } catch (err) {
    throw new PushError(`the patch is not one git can read; nothing was changed (${gitText(err)})`);
  }
  const t = raw.toString('utf8').split('\0');
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t(.*)$/s.exec(t[i]!);
    if (!m) continue;
    if (m[1]) out.push(m[1]);
    else out.push(t[++i]!, t[++i]!); // a rename: the old path, then the new
  }
  return out.filter(Boolean);
}

/** Every path with a local change not committed: modified, staged, unmerged or untracked. */
async function uncommitted(root: string): Promise<Set<string>> {
  const t = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .toString('utf8')
    .split('\0');
  const out = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    const e = t[i]!;
    if (e.length < 4) continue;
    out.add(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') out.add(t[++i]!); // the rename's source
  }
  return out;
}

const gitText = (err: unknown) =>
  sanitizeRemote(String((err as { stderr?: Buffer }).stderr ?? err))
    .trim()
    .split('\n')
    .filter((l) => !/^(Falling back|Applied patch|Recorded preimage)/.test(l))
    .slice(0, 8)
    .join('; ');

/** The paths git names in a failed apply's `error: <path>: ...` lines. */
function failedPaths(err: unknown): string[] {
  const text = String((err as { stderr?: Buffer }).stderr ?? '');
  const out = new Set<string>();
  for (const m of text.matchAll(/^error: (?:patch failed: )?(.+?)(?::\d+)?(?:: .*)?$/gm)) {
    out.add(sanitizeRemote(m[1]!));
  }
  return [...out];
}

const list = (ps: string[]) =>
  ps.length > 10 ? `${ps.slice(0, 10).join(', ')} and ${ps.length - 10} more` : ps.join(', ');

/**
 * Applies a pulled patch in the local repository (R6c):
 * 1. a plain `git apply`, which changes only the working tree and is all or nothing;
 * 2. if that fails because a file it touches has uncommitted local changes, it is refused with
 *    those files named, and nothing is changed;
 * 3. otherwise (the files differ only by local commits), `git apply --3way`. On a clean merge the
 *    touched paths' index entries go back to what they were (their HEAD), so the index is as
 *    before; a conflict leaves git's markers, named, and the error says what to do.
 * Returns the paths the patch touched.
 */
export async function applyPatch(root: string, patch: Buffer): Promise<string[]> {
  if (patch.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), 'sbx-pull-'));
  const f = join(dir, 'sbx.patch');
  writeFileSync(f, patch, { mode: 0o600 });
  try {
    const touched = await patchPaths(root, f);
    // The binding is the laptop's: a patch that would write it (an agent that un-excluded .sbx/
    // in the sandbox) could repoint every later command, so it is refused outright.
    const binding = touched.filter((p) => p === '.sbx' || p.startsWith('.sbx/'));
    if (binding.length) {
      throw new PushError(
        `the patch writes ${list(binding)}, this repository's sandbox binding, which a pull never ` +
          'changes; nothing was changed. Look at it with mocactl sbx pull -o FILE',
      );
    }
    let plainErr: unknown;
    try {
      await git(root, ['apply', '--whitespace=nowarn', f]);
      return touched;
    } catch (err) {
      plainErr = err;
    }
    const dirty = await uncommitted(root);
    const local = touched.filter((p) => dirty.has(p));
    if (local.length) {
      const failing = failedPaths(plainErr).filter((p) => !local.includes(p));
      throw new PushError(
        `the patch does not apply here, and it touches files with local changes not yet ` +
          `committed (${list(local)}), so no 3-way merge was tried; nothing was changed. ` +
          (failing.length ? `It also does not apply to ${list(failing)} as committed. ` : '') +
          'Commit or stash the local changes, then run mocactl sbx pull --apply again ' +
          `(git said: ${gitText(plainErr)})`,
      );
    }
    try {
      await git(root, ['apply', '--3way', '--whitespace=nowarn', f]);
    } catch (err) {
      const conflicted = [...(await uncommitted(root))].filter((p) => touched.includes(p));
      const unmerged = (await git(root, ['diff', '--name-only', '-z', '--diff-filter=U']))
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      if (unmerged.length) {
        throw new PushError(
          `the patch conflicted with local commits: conflict markers in ${list(unmerged)} ` +
            '(the cleanly merged files are staged). Resolve them and commit; the sandbox still ' +
            'holds its changes, so then run mocactl sbx push --force to make it match',
        );
      }
      throw new PushError(
        `the patch did not apply (git said: ${gitText(err)})` +
          (conflicted.length
            ? `; files it may have changed: ${list(conflicted)}`
            : '; nothing was changed'),
      );
    }
    // A clean merge staged its paths; they were at HEAD before (step 2), so put the index back.
    if (touched.length) {
      await git(
        root,
        ['--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
        Buffer.from(touched.join('\0') + '\0', 'utf8'),
      );
    }
    return touched;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The control-plane URL as later commands will read it back (`readBinding`: http(s), printable
 * ASCII), unchanged, since it must equal the login's URL. An internationalized host is refused
 * with its ASCII form to use instead: rewriting it here would no longer match the login.
 */
export function bindingUrl(url: string): string {
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    u = undefined;
  }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
    throw new PushError(`the control-plane URL is not an http(s) URL: ${sanitizeRemote(url)}`);
  }
  if (BINDING_URL_RE.test(url)) return url;
  const ascii = u.href.replace(/\/+$/, '');
  if (BINDING_URL_RE.test(ascii)) {
    throw new PushError(
      `the control-plane URL must be ASCII to be recorded in .sbx/sandbox.json; use ${ascii} ` +
        `(log in with mocactl sbx login --control-plane-url ${q(ascii)})`,
    );
  }
  throw new PushError(`the control-plane URL cannot be recorded: ${sanitizeRemote(url)}`);
}

/** `info/exclude` of the repository at `root`: the common one, for a linked worktree too. */
function excludeFile(root: string): string {
  const p = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return resolve(root, p);
}

/**
 * Binds the repository to its sandbox: `.sbx/sandbox.json`, with `.sbx/` added to the
 * repository's `info/exclude`, never to `.gitignore` (spec §6.1). Refuses a binding later commands
 * would silently ignore (a bad id, a URL `readBinding` would drop).
 */
export function writeBinding(
  root: string,
  b: { id: string; controlPlaneUrl: string; template: string },
): void {
  if (!SANDBOX_ID_RE.test(b.id)) throw new PushError(`not a sandbox id: ${sanitizeRemote(b.id)}`);
  const controlPlaneUrl = bindingUrl(b.controlPlaneUrl);
  const exclude = excludeFile(root);
  mkdirSync(dirname(exclude), { recursive: true });
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').some((l) => l.trim() === '.sbx/' || l.trim() === '/.sbx/')) {
    appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.sbx/\n`);
  }
  mkdirSync(join(root, '.sbx'), { recursive: true });
  const f = join(root, '.sbx', 'sandbox.json');
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ id: b.id, controlPlaneUrl, template: b.template }, null, 2) + '\n',
  );
  renameSync(tmp, f);
}
