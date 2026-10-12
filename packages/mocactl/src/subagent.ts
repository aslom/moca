/** `mocactl spawn | subagents | get`, built on the leaf-turn transport and subagent ledger. */
import { spawn as spawnChild } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
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
  isTerminalState,
  mapHonestState,
  terminalFromBody,
  type LeafEnvelope,
  type LeafResultBody,
  type StateView,
} from './transport/leaf-turn.js';

const BUNDLE_DIGEST = /^sha256:[0-9a-f]{64}$/;
/**
 * Cap keeps a ledger append small enough that one `O_APPEND` `write(2)` on a local filesystem
 * commits the whole line as one unit, which is what keeps concurrent writers from interleaving.
 */
const MAX_PROMPT_BYTES = 64 * 1024;
/** Harness-side session-id alphabet (mirrors run-leaf.ts `leafSessionId`). */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;

interface SpawnedSession {
  sessionId: string;
  token: string;
}

/** Payload passed on stdin from `spawn` to the detached `__spawn-worker` process. */
export interface SpawnWorkerPayload {
  sessionId: string;
  token: string;
  envelope: LeafEnvelope;
  /** Resolved control-plane and harness URLs, so a child without flag/env access can rebuild them. */
  controlPlaneUrl?: string;
  harnessUrl?: string;
}

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

// --- spawn ---

export interface SpawnOptions {
  prompt: string;
  kind: 'prompt' | 'solve';
  /** The promoted config-bundle digest (`sha256:…`), passed through as the session's `configRef`. */
  configRef?: string;
  repoUrl?: string;
  ref?: string;
  tag?: string;
  json: boolean;
  /** Test seams: fork + ledger injection. */
  forkFn?: (
    sessionId: string,
    token: string,
    envelope: LeafEnvelope,
    cwd: string,
  ) => number | Promise<number>;
  ledger?: Ledger;
}

/** Create session, record it, fork a detached worker, return. Worker survives mocactl exit. */
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
  if (opts.configRef && !BUNDLE_DIGEST.test(opts.configRef)) {
    io.err('a bundle digest is sha256:<64 lowercase hex>, as `mocactl promote` prints it');
    return 2;
  }
  if (opts.kind === 'solve') {
    if (!opts.repoUrl || !opts.ref) {
      io.err('--kind solve needs both --repo URL and --ref REF');
      return 2;
    }
  } else if (opts.repoUrl || opts.ref) {
    io.err('--repo and --ref are only meaningful with --kind solve');
    return 2;
  }

  let session: SpawnedSession;
  try {
    session = await createSession(rt.cp, opts.configRef);
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  // Defense-in-depth: the harness mints these, but a would-be bug on either side should not let a
  // sessionId with path metacharacters reach `join()` for the worker log.
  if (!SAFE_ID_RE.test(session.sessionId)) {
    io.err(`control plane returned an unexpected sessionId '${sanitizeRemote(session.sessionId)}'`);
    return 1;
  }

  const envelope: LeafEnvelope = buildEnvelope(session.sessionId, opts);
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  // Record before fork so a crash in between leaves a durable row to recover from.
  const record: LedgerRecord = {
    sessionId: session.sessionId,
    ...(opts.tag ? { tag: opts.tag } : {}),
    envelope: envelopeForLedger(opts),
    ...(opts.configRef ? { bundle: opts.configRef } : {}),
    ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    submittedAt: rt.now(),
    lastKnownState: 'running',
    stateObservedAt: rt.now(),
  };
  ledger.append(record);

  const forkFn = opts.forkFn ?? ((sid, tok, env, cwd) => defaultFork(sid, tok, env, cwd, rt));
  let pid: number;
  try {
    pid = await forkFn(session.sessionId, session.token, envelope, rt.paths.stateDir);
  } catch (err) {
    // Fork failed after session was created — mark the ledger row failed with the fork error.
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

async function createSession(cp: ControlPlaneApi, configRef?: string): Promise<SpawnedSession> {
  const req: CreateSessionRequest = configRef ? { configRef } : {};
  const created = await cp.createSession(req);
  return { sessionId: created.sessionId, token: created.token };
}

function buildEnvelope(sessionId: string, opts: SpawnOptions): LeafEnvelope {
  const base: LeafEnvelope = { sessionId, kind: opts.kind };
  // configRef on the envelope is what makes the leaf run with the user's promoted bundle: `/runs`
  // reads it from the body (run-leaf.ts `runPromptLeaf`/`runSolveLeaf`), not from the session.
  if (opts.configRef) base.configRef = opts.configRef;
  if (opts.kind === 'prompt') return { ...base, prompt: opts.prompt };
  // solve: the user's intent is `problemStatement`; the harness builds the agent's prompt itself.
  return { ...base, problemStatement: opts.prompt, repoUrl: opts.repoUrl!, ref: opts.ref! };
}

function envelopeForLedger(opts: SpawnOptions): LedgerEnvelope {
  return {
    kind: opts.kind,
    prompt: opts.prompt,
    ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(opts.configRef ? { configRef: opts.configRef } : {}),
  };
}

/** Fork a detached worker (body: `mocactl __spawn-worker`) holding the sync POST /v1/runs. */
async function defaultFork(
  sessionId: string,
  token: string,
  envelope: LeafEnvelope,
  stateDir: string,
  rt: Runtime,
): Promise<number> {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = join(stateDir, `spawn-${sessionId}.log`);
  const logFd = openSync(logPath, 'a', 0o600);
  try {
    const child = spawnChild(process.execPath, [process.argv[1]!, '__spawn-worker'], {
      detached: true,
      stdio: ['pipe', logFd, logFd],
      env: { ...process.env },
    });
    // ENOENT/EACCES on execPath land as an async 'error' event rather than a sync throw. Wait
    // for whichever event fires first — 'spawn' (the child successfully started) or 'error' —
    // before telling the caller the pid is valid. Without this, the parent would report success
    // for a worker that never actually ran.
    await new Promise<void>((resolveStart, rejectStart) => {
      child.once('spawn', () => resolveStart());
      child.once('error', (err) => rejectStart(err));
    });
    // Pass the session token on stdin so it stays out of argv (visible to `ps`). Forward the
    // resolved endpoints the same way so the child rebuilds its runtime from a single source.
    const payload: SpawnWorkerPayload = {
      sessionId,
      token,
      envelope,
      ...(rt.endpoints.controlPlaneUrl ? { controlPlaneUrl: rt.endpoints.controlPlaneUrl } : {}),
      ...(rt.endpoints.harnessUrl ? { harnessUrl: rt.endpoints.harnessUrl } : {}),
    };
    child.stdin!.end(JSON.stringify(payload) + '\n');
    child.unref();
    if (child.pid === undefined) throw new Error('spawn produced no pid');
    return child.pid;
  } catch (err) {
    closeSync(logFd);
    throw err;
  }
}

export interface SpawnWorkerDeps {
  /** Overrides stdin reading; the real binary routes `process.stdin` through main.ts. */
  readStdin?: () => Promise<string>;
  /** Overrides the ledger; the real binary opens the on-disk ledger. */
  ledger?: Ledger;
  /** Overrides the leaf-turn transport; the real binary builds one from `rt.harness`. */
  transport?: LeafTransport;
}

/**
 * Detached-worker entry: read payload from stdin, POST /v1/runs, record outcome, exit.
 * Every exit path that has a sessionId writes a ledger update (terminal, or a running-ping on
 * saturated). The malformed-stdin branch has no sessionId to anchor an update; the parent's
 * `record` row stays authoritative, and `subagents` reconciles it from `/v1/runs/status`.
 */
export async function runSpawnWorker(rt: Runtime, deps: SpawnWorkerDeps = {}): Promise<number> {
  const ledger = deps.ledger ?? openLedger(rt.paths.subagentsFile, rt.now);
  const readStdinFn = deps.readStdin ?? readStdin;
  let payload: SpawnWorkerPayload;
  try {
    const parsed = JSON.parse(await readStdinFn()) as Partial<SpawnWorkerPayload>;
    if (!parsed || typeof parsed.sessionId !== 'string' || typeof parsed.token !== 'string') {
      return 2;
    }
    payload = parsed as SpawnWorkerPayload;
  } catch {
    // Malformed stdin: no sessionId to anchor a ledger update. The parent printed the sessionId
    // on stdout before forking, so the row the parent appended at spawn time is what `subagents`
    // sees; it will drive it from `/v1/runs/status` on the next call.
    return 2;
  }
  // Rebuild runtime endpoints if the parent forwarded them (the child's env/flags are empty).
  if (!rt.harness && (payload.harnessUrl || payload.controlPlaneUrl)) {
    const { applyEndpoints } = await import('./runtime.js');
    applyEndpoints(rt, {
      controlPlaneUrl: payload.controlPlaneUrl,
      harnessUrl: payload.harnessUrl,
    });
  }
  if (!rt.harness) {
    ledger.updateState(payload.sessionId, 'failed', {
      detail: 'worker has no harness URL (missing --harness-url or SH_HARNESS_URL)',
      now: rt.now(),
    });
    return 2;
  }
  const transport = deps.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  try {
    const body = await transport.submitLeafTurn(payload.envelope, payload.token);
    // Sync 503 saturated is a retry-later signal (`run-leaf.ts`: "a 503 is 'retry', not a
    // terminal failure, and /v1/runs/status must not report it as one"). Keep the row running
    // but bump stateObservedAt so the 60s grace restarts from exit instead of from spawn.
    if (body.status === 'failed' && body.reason === 'saturated') {
      ledger.updateState(payload.sessionId, 'running', {
        detail: 'saturated — retry',
        now: rt.now(),
      });
      return 1;
    }
    const view = terminalFromBody(body);
    ledger.updateState(payload.sessionId, view.state, {
      detail: view.detail,
      now: rt.now(),
    });
    return view.state === 'done' ? 0 : 1;
  } catch (err) {
    ledger.updateState(payload.sessionId, 'failed', {
      detail: err instanceof Error ? err.message : String(err),
      now: rt.now(),
    });
    return 1;
  }
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

// --- subagents ---

export interface SubagentsOptions {
  tag?: string;
  json: boolean;
  signal?: AbortSignal;
  /** Test seams. */
  ledger?: Ledger;
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
    // Ledger is authoritative past a terminal state — /v1/runs/status has a 24h TTL, so re-reading
    // would regress a durable `done` row to `unknown` once the server-side record ages out.
    if (isTerminalState(r.lastKnownState)) {
      views.push({ record: r, view: { state: r.lastKnownState, detail: r.stateDetail } });
      continue;
    }
    const alive = r.childPid !== undefined && isAlive(r.childPid);
    const observedAt = alive ? now : r.stateObservedAt;
    let raw: LeafResultBody | 'queued';
    try {
      const token = await rt.cp.mintSessionToken(r.sessionId);
      raw = await transport.readLeafState(r.sessionId, token.token, opts.signal);
    } catch (err) {
      // One row's failure doesn't fail the list.
      views.push({ record: r, view: { state: 'unknown', detail: describeError(err) } });
      continue;
    }
    views.push({
      record: r,
      view: mapHonestState(raw, { alive, observedAt }, now, DEFAULT_UNKNOWN_GRACE_MS),
    });
  }
  // Persist any state changes so the next `subagents` call starts closer to the truth.
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

/**
 * `kill(pid, 0)` liveness probe. OS pid reuse is the known blind spot — a pid+start-time pair
 * or a harness-side deadline (tracked under the spec's Scope) closes it.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only probes.
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

// --- get ---

export interface GetOptions {
  sessionId: string;
  outDir?: string;
  json: boolean;
  signal?: AbortSignal;
  transport?: LeafTransport;
}

const GET_SUMMARY_LINES = 10;

export async function cmdGet(rt: Runtime, io: Io, opts: GetOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  if (!SAFE_ID_RE.test(opts.sessionId)) {
    io.err(`invalid sessionId '${sanitizeRemote(opts.sessionId)}'`);
    return 2;
  }
  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  let raw: LeafResultBody | 'queued';
  try {
    const token = await rt.cp.mintSessionToken(opts.sessionId);
    raw = await transport.readLeafState(opts.sessionId, token.token, opts.signal);
  } catch (err) {
    // A 404 with code=session_not_found means the harness has no record of this sessionId; other
    // 404s (route misconfig, auth-mapping) should surface as the real error, not as "no session".
    if (err instanceof ApiError && err.status === 404 && err.code === 'session_not_found') {
      io.err(`no session '${sanitizeRemote(opts.sessionId)}'`);
      return 1;
    }
    io.err(describeError(err));
    return 1;
  }
  if (raw === 'queued') {
    io.err(`session '${sanitizeRemote(opts.sessionId)}' has not finished yet`);
    if (opts.json) io.out(JSON.stringify({ sessionId: opts.sessionId, status: 'queued' }) + '\n');
    return 1;
  }
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
  // Exit 0 only for a complete answer; `paused` is terminal but still awaiting a gate decision.
  const completed = raw.status === 'responded' || raw.status === 'done' || raw.status === 'solved';
  // Status (and any failure reason/message) come from the server; sanitize before echoing them.
  const status = sanitizeRemote(raw.status);
  const reason = raw.reason ? sanitizeRemote(raw.reason) : undefined;
  const message = raw.message ? sanitizeRemote(raw.message) : undefined;
  if (opts.json) {
    io.out(
      JSON.stringify({
        sessionId: opts.sessionId,
        status,
        files: written,
        ...(reason ? { reason } : {}),
        ...(message ? { message } : {}),
      }) + '\n',
    );
    return completed ? 0 : 1;
  }
  io.err(`status  ${status}`);
  if (reason) io.err(`reason  ${reason}`);
  if (message && message !== reason) io.err(`detail  ${message}`);
  for (const p of written) io.err(`wrote   ${p}`);
  const summaryBody = raw.text ?? raw.patch ?? '';
  if (summaryBody) {
    const head = summaryBody.split('\n').slice(0, GET_SUMMARY_LINES).join('\n');
    io.out(sanitizeRemote(head) + (summaryBody.includes('\n') ? '\n' : ''));
  }
  return completed ? 0 : 1;
}
