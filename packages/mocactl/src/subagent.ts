/**
 * `mocactl spawn | subagents | get` — subagent command surface.
 *
 * These commands sit above the leaf-turn transport (src/transport/leaf-turn.ts) and the
 * subagent ledger (src/core/subagent-ledger.ts). The transport is the one place a leaf is
 * dispatched or read back; the ledger is the one place the caller remembers what it spawned.
 * Future subagent commands (watch, approve, follow-up) plug into these two primitives without
 * changing the three commands here.
 */
import { spawn as spawnChild } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApiError } from './api/errors.js';
import type { ControlPlaneApi, CreateSessionRequest } from './api/types.js';
import { describeError } from './core/messages.js';
import { sanitizeRemote } from './core/sanitize.js';
import {
  initLedger,
  openLedger,
  type Ledger,
  type LedgerEnvelope,
  type LedgerRecord,
} from './core/subagent-ledger.js';
import type { Io } from './headless.js';
import type { Runtime } from './runtime.js';
import {
  DEFAULT_UNKNOWN_GRACE_MS,
  LeafTransport,
  mapHonestState,
  type HonestState,
  type LeafEnvelope,
  type LeafResultBody,
  type StateView,
} from './transport/leaf-turn.js';

/* ----------------------------------------------------------------- *
 * Shared types + helpers                                             *
 * ----------------------------------------------------------------- */

const BUNDLE_DIGEST = /^sha256:[0-9a-f]{64}$/;
/**
 * Prompt size cap. The dispatch envelope is persisted to the ledger (so a future `approve`
 * command can resend it), and the ledger's append-only JSONL relies on POSIX atomic appends
 * under PIPE_BUF (4 KiB) for concurrent-write safety. A multi-MB prompt would overflow that
 * guarantee and could interleave with concurrent writers.
 */
const MAX_PROMPT_BYTES = 64 * 1024;

/** Minted session + token enough for both the dispatch POST and later /runs/status reads. */
interface SpawnedSession {
  sessionId: string;
  token: string;
}

/** False (with the reason on stderr) unless there's a logged-in control plane and a harness. */
function requireReady(
  rt: Runtime,
  io: Io,
): rt is Runtime & Required<Pick<Runtime, 'cp' | 'harness'>> {
  if (!rt.cp || !rt.harness) {
    io.err('missing control-plane URL — pass --control-plane-url or set SH_CONTROL_PLANE_URL');
    return false;
  }
  if (!rt.auth) {
    io.err('not logged in — run `mocactl login` first');
    return false;
  }
  return true;
}

/** Session-id form the harness accepts for /runs envelopes (same alphabet as toSessionId). */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;

/* ----------------------------------------------------------------- *
 * `mocactl spawn`                                                    *
 * ----------------------------------------------------------------- */

export interface SpawnOptions {
  prompt: string;
  kind: 'prompt' | 'converge';
  bundle?: string;
  repoUrl?: string;
  ref?: string;
  tag?: string;
  json: boolean;
  /** Test-seam: inject a fork so unit tests can observe the detached-child wire without spawning. */
  forkFn?: (sessionId: string, token: string, envelope: LeafEnvelope, cwd: string) => number;
  /** Test-seam: inject the ledger (unit tests use a tmp path). */
  ledger?: Ledger;
}

/**
 * Create a session, mint its token, write a ledger record BEFORE forking (so a crash between
 * fork and record-write never orphans a session), fork a detached worker that holds the sync
 * POST /runs, then return. The worker lives outside this process group, so quitting mocactl
 * does not kill it.
 */
export async function cmdSpawn(rt: Runtime, io: Io, opts: SpawnOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  if (!opts.prompt.trim()) {
    io.err('spawn needs a non-empty prompt');
    return 2;
  }
  if (Buffer.byteLength(opts.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    io.err(
      `prompt is too large (max ${MAX_PROMPT_BYTES} bytes); pipe large inputs into a file the agent can read instead`,
    );
    return 2;
  }
  if (opts.bundle && !BUNDLE_DIGEST.test(opts.bundle)) {
    io.err('a bundle digest is sha256:<64 lowercase hex>, as `mocactl promote` prints it');
    return 2;
  }
  if (opts.kind === 'converge') {
    if (!opts.repoUrl || !opts.ref) {
      io.err('--kind converge needs both --repo URL and --ref REF');
      return 2;
    }
  } else if (opts.repoUrl || opts.ref) {
    io.err('--repo and --ref are only meaningful with --kind converge');
    return 2;
  }

  let session: SpawnedSession;
  try {
    session = await createSession(rt.cp, opts.bundle);
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }

  const envelope: LeafEnvelope = buildEnvelope(session.sessionId, opts);
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  // Record BEFORE fork: a crash between fork and record-write would otherwise leave a running
  // worker with no caller-side record.
  const record: LedgerRecord = {
    sessionId: session.sessionId,
    ...(opts.tag ? { tag: opts.tag } : {}),
    envelope: envelopeForLedger(opts),
    ...(opts.bundle ? { bundle: opts.bundle } : {}),
    ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    submittedAt: rt.now(),
    lastKnownState: 'running',
    stateObservedAt: rt.now(),
  };
  ledger.append(record);

  const forkFn = opts.forkFn ?? defaultFork;
  let pid: number;
  try {
    pid = forkFn(session.sessionId, session.token, envelope, rt.paths.stateDir);
  } catch (err) {
    // A fork failure after a successful session create is the one state that would otherwise
    // orphan a ledger row with no worker. Mark the row `failed` with the fork error so the
    // operator sees the real cause via `mocactl subagents`.
    ledger.updateState(session.sessionId, 'failed', {
      detail: err instanceof Error ? err.message : String(err),
      now: rt.now(),
    });
    io.err(describeError(err));
    return 1;
  }
  ledger.updateState(session.sessionId, 'running', { childPid: pid, now: rt.now() });

  io.err(`spawned ${session.sessionId}  (pid ${pid})`);
  if (opts.json) {
    io.out(JSON.stringify({ type: 'session', sessionId: session.sessionId, pid }) + '\n');
  } else {
    io.out(`${session.sessionId}\n`);
  }
  return 0;
}

async function createSession(cp: ControlPlaneApi, bundle?: string): Promise<SpawnedSession> {
  const req: CreateSessionRequest = bundle ? { configRef: bundle } : {};
  const created = await cp.createSession(req);
  return { sessionId: created.sessionId, token: created.token };
}

function buildEnvelope(sessionId: string, opts: SpawnOptions): LeafEnvelope {
  // The verdict path requires an `item` even for prompt leaves; a synthetic one is harmless
  // because the prompt kind only reads `prompt` (harness/src/run-leaf.ts). Converge reads item
  // for the pattern + require_approval; spawn exposes neither flag, so a passthrough item is
  // right here. Future expansions (gates, patterns) would add explicit flags.
  const item = { item_id: 'spawn', file: '-', pattern: '-' };
  return {
    sessionId,
    kind: opts.kind,
    ...(opts.kind === 'prompt' ? { prompt: opts.prompt } : {}),
    ...(opts.kind === 'converge'
      ? { prompt: opts.prompt, repoUrl: opts.repoUrl!, ref: opts.ref! }
      : {}),
    item,
  };
}

function envelopeForLedger(opts: SpawnOptions): LedgerEnvelope {
  return {
    kind: opts.kind,
    prompt: opts.prompt,
    ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(opts.bundle ? { configRef: opts.bundle } : {}),
  };
}

/**
 * Fork a detached worker that holds the sync `POST /runs` and exits once the response is in
 * the ledger. The worker needs the session token to call /runs; we pass it on stdin to the
 * worker so it never shows up in `ps` output. The worker body is `mocactl __spawn-worker`,
 * added to cli.ts.
 */
function defaultFork(
  sessionId: string,
  token: string,
  envelope: LeafEnvelope,
  stateDir: string,
): number {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Logs on error (child cannot write stdout; this is the one place to find a crashed worker).
  const logPath = join(stateDir, `spawn-${sessionId}.log`);
  const logFd = openSync(logPath, 'a', 0o600);
  const child = spawnChild(process.execPath, [process.argv[1]!, '__spawn-worker'], {
    detached: true,
    stdio: ['pipe', logFd, logFd],
    env: { ...process.env },
  });
  // Pass the leaf-dispatch payload on stdin so no secret shows up in `ps`.
  const payload = JSON.stringify({ sessionId, token, envelope });
  child.stdin!.end(payload + '\n');
  child.unref();
  return child.pid!;
}

/**
 * Entry point for the detached worker. Reads {sessionId, token, envelope} from stdin,
 * POSTs /runs, writes the result to the ledger, exits. Any throw is swallowed so an unhandled
 * rejection does not leave a confusing stack in the log; the ledger update is best-effort.
 */
export async function runSpawnWorker(rt: Runtime): Promise<number> {
  if (!rt.harness) {
    // No harness URL — nothing to POST to. The parent already recorded a 'running' state, so
    // the ledger shows that until the row ages into 'unknown' per the honest-state grace rule.
    return 2;
  }
  const payload = await readStdin();
  let parsed: { sessionId: string; token: string; envelope: LeafEnvelope };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return 2;
  }
  const transport = new LeafTransport(rt.harness);
  const ledger = openLedger(rt.paths.subagentsFile, rt.now);
  try {
    const body = await transport.submitLeafTurn(parsed.envelope, parsed.token);
    const state = terminalFromBody(body);
    ledger.updateState(parsed.sessionId, state.state, {
      detail: state.detail,
      now: rt.now(),
    });
    return state.state === 'done' ? 0 : 1;
  } catch (err) {
    ledger.updateState(parsed.sessionId, 'failed', {
      detail: err instanceof Error ? err.message : String(err),
      now: rt.now(),
    });
    return 1;
  }
}

function terminalFromBody(body: LeafResultBody): { state: HonestState; detail?: string } {
  if (body.status === 'responded' || body.status === 'done' || body.status === 'solved')
    return { state: 'done' };
  if (body.status === 'paused') return { state: 'paused', detail: 'gate requested' };
  if (body.status === 'failed') return { state: 'failed', detail: body.reason ?? body.message };
  return { state: 'unknown', detail: `server returned status '${body.status}'` };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/* ----------------------------------------------------------------- *
 * `mocactl subagents`                                                *
 * ----------------------------------------------------------------- */

export interface SubagentsOptions {
  tag?: string;
  json: boolean;
  signal?: AbortSignal;
  /** Test seam: inject the ledger. */
  ledger?: Ledger;
  /** Test seam: inject the transport (so tests avoid real /runs/status). */
  transport?: LeafTransport;
}

export async function cmdSubagents(rt: Runtime, io: Io, opts: SubagentsOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  initLedger(rt.paths.subagentsFile);
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  const records = ledger.readAll().filter((r) => (opts.tag ? r.tag === opts.tag : true));
  if (records.length === 0) {
    io.err('no subagents' + (opts.tag ? ` with tag '${sanitizeRemote(opts.tag)}'` : ''));
    if (opts.json) io.out(JSON.stringify({ subagents: [] }) + '\n');
    return 0;
  }
  const now = rt.now();
  const views: Array<{ record: LedgerRecord; view: StateView }> = [];
  for (const r of records) {
    const alive = r.childPid !== undefined && isAlive(r.childPid);
    const observedAt = alive ? now : r.stateObservedAt;
    let raw: LeafResultBody | 'queued' | 'not_found';
    try {
      const token = await rt.cp.mintSessionToken(r.sessionId);
      raw = await transport.readLeafState(r.sessionId, token.token, opts.signal);
    } catch (err) {
      // Keep going on other rows: one session that aged out should not fail the whole list.
      // The row shows the last known state from the ledger as its only honest answer.
      views.push({ record: r, view: { state: 'unknown', detail: describeError(err) } });
      continue;
    }
    views.push({
      record: r,
      view: mapHonestState(raw, { alive, observedAt }, now, DEFAULT_UNKNOWN_GRACE_MS),
    });
  }
  // Persist what we learned so a later `subagents` call starts closer to the truth.
  for (const { record, view } of views) {
    if (view.state !== record.lastKnownState || view.detail !== record.stateDetail) {
      ledger.updateState(record.sessionId, view.state, { detail: view.detail, now });
    }
  }
  if (opts.json) {
    io.out(
      JSON.stringify({
        subagents: views.map(({ record, view }) => ({
          sessionId: record.sessionId,
          tag: record.tag ?? null,
          kind: record.envelope.kind,
          state: view.state,
          detail: view.detail ?? null,
          bundle: record.bundle ?? null,
          submittedAt: record.submittedAt,
        })),
      }) + '\n',
    );
    return 0;
  }
  // Aligned table with a header row (matches cmdSessions' style).
  const header = ['SESSION', 'TAG', 'KIND', 'STATE', 'BUNDLE'];
  const rows = views.map(({ record, view }) => [
    sanitizeRemote(record.sessionId),
    sanitizeRemote(record.tag ?? '-'),
    record.envelope.kind,
    view.state + (view.detail ? ` (${sanitizeRemote(view.detail)})` : ''),
    sanitizeRemote(record.bundle ?? '-'),
  ]);
  io.out(renderTable([header, ...rows]));
  return 0;
}

function isAlive(pid: number): boolean {
  try {
    // kill 0 doesn't send a signal; it just checks whether the pid exists for this user.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  return (
    rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ')).join('\n') + '\n'
  );
}

/* ----------------------------------------------------------------- *
 * `mocactl get <sessionId>`                                          *
 * ----------------------------------------------------------------- */

export interface GetOptions {
  sessionId: string;
  outDir?: string;
  json: boolean;
  signal?: AbortSignal;
  /** Test seam: inject the transport. */
  transport?: LeafTransport;
}

/** How many lines of text (or patch) show in the bounded summary when --json is off. */
const GET_SUMMARY_LINES = 10;

export async function cmdGet(rt: Runtime, io: Io, opts: GetOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  if (!SAFE_ID_RE.test(opts.sessionId)) {
    io.err(`invalid sessionId '${sanitizeRemote(opts.sessionId)}'`);
    return 2;
  }
  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  let raw: LeafResultBody | 'queued' | 'not_found';
  try {
    const token = await rt.cp.mintSessionToken(opts.sessionId);
    raw = await transport.readLeafState(opts.sessionId, token.token, opts.signal);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      io.err(`no session '${sanitizeRemote(opts.sessionId)}'`);
      return 1;
    }
    io.err(describeError(err));
    return 1;
  }
  if (raw === 'not_found') {
    io.err(`no session '${sanitizeRemote(opts.sessionId)}'`);
    return 1;
  }
  if (raw === 'queued') {
    io.err(`session '${sanitizeRemote(opts.sessionId)}' has not finished yet`);
    if (opts.json) io.out(JSON.stringify({ sessionId: opts.sessionId, status: 'queued' }) + '\n');
    return 1;
  }
  // Terminal body: write artifacts to the out dir (default cwd), then print a bounded summary.
  const outDir = resolve(opts.outDir ?? '.');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  if (raw.text) {
    const p = join(outDir, `${opts.sessionId}.text`);
    writeFileSync(p, raw.text, { mode: 0o644 });
    written.push(p);
  }
  if (raw.verdict !== undefined) {
    const p = join(outDir, `${opts.sessionId}.verdict.json`);
    writeFileSync(p, JSON.stringify(raw.verdict, null, 2) + '\n', { mode: 0o644 });
    written.push(p);
  }
  if (raw.patch) {
    const p = join(outDir, `${opts.sessionId}.patch`);
    writeFileSync(p, raw.patch.endsWith('\n') ? raw.patch : raw.patch + '\n', { mode: 0o644 });
    written.push(p);
  }
  if (opts.json) {
    io.out(
      JSON.stringify({ sessionId: opts.sessionId, status: raw.status, files: written }) + '\n',
    );
    return raw.status === 'failed' ? 1 : 0;
  }
  io.err(`status  ${raw.status}`);
  for (const p of written) io.err(`wrote   ${p}`);
  const summaryBody = raw.text ?? raw.patch ?? '';
  if (summaryBody) {
    const head = summaryBody.split('\n').slice(0, GET_SUMMARY_LINES).join('\n');
    io.out(sanitizeRemote(head) + (summaryBody.includes('\n') ? '\n' : ''));
  }
  return raw.status === 'failed' ? 1 : 0;
}
