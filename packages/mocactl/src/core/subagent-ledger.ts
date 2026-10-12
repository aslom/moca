/**
 * Subagent ledger: client-side batch record of leaves this operator spawned.
 *
 * Stored at $XDG_STATE_HOME/mocactl/subagents.jsonl, mode 0600. Append-only JSONL with periodic
 * compaction: each line is either an initial record or an update. `readAll` folds updates into
 * records keyed by sessionId.
 *
 * The ledger is the *caller's* authority on the parent/child tree (there is no server-side
 * parentSessionId today). `subagents` renders this file joined with /runs/status.
 *
 * Concurrency: POSIX guarantees atomic appends under PIPE_BUF (4 KiB). Each JSONL line is well
 * under that limit for both initial records and updates, so concurrent spawn + subagents reads
 * do not need a user-space lock on the common path. Compaction is the one write that rewrites
 * the whole file; it uses a `.tmp` + rename pattern so a reader never sees a torn file.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { HonestState } from '../transport/leaf-turn.js';

export interface LedgerEnvelope {
  /** Full dispatch envelope — needed for a future `approve/reject` to resend with a decision. */
  kind: 'prompt' | 'converge';
  prompt?: string;
  item?: unknown;
  repoUrl?: string;
  ref?: string;
  configRef?: string;
}

export interface LedgerRecord {
  sessionId: string;
  tag?: string;
  bundle?: string;
  envelope: LedgerEnvelope;
  submittedAt: number;
  /** The detached worker's pid. Absent until the child is forked. */
  childPid?: number;
  /** Latest observed state. Starts as 'running'. */
  lastKnownState: HonestState;
  stateDetail?: string;
  /** Epoch ms the state was last updated. */
  stateObservedAt: number;
}

/**
 * A line in the JSONL. `record` is an initial write; `update` is a state transition keyed by
 * sessionId. The dual shape keeps the on-disk file append-only (fast + lock-free) while still
 * supporting state mutations without rewriting history.
 */
type LedgerLine =
  | { v: 1; type: 'record'; record: LedgerRecord }
  | {
      v: 1;
      type: 'update';
      sessionId: string;
      lastKnownState: HonestState;
      stateDetail?: string;
      stateObservedAt: number;
      /** Set when the detached worker's pid is first known. */
      childPid?: number;
    };

export interface Ledger {
  append(record: LedgerRecord): void;
  updateState(
    sessionId: string,
    lastKnownState: HonestState,
    opts?: { detail?: string; childPid?: number; now?: number },
  ): void;
  readAll(): LedgerRecord[];
  find(sessionId: string): LedgerRecord | undefined;
  /**
   * Rewrites the ledger with only the folded current state of each session. Not needed on the
   * common path; exposed so a future `mocactl subagents --prune` or housekeeping job can call it.
   */
  compact(): void;
}

export function openLedger(path: string, now: () => number = Date.now): Ledger {
  ensureParentDir(path);
  return {
    append(record: LedgerRecord): void {
      writeLine(path, { v: 1, type: 'record', record });
    },
    updateState(sessionId, lastKnownState, opts = {}): void {
      writeLine(path, {
        v: 1,
        type: 'update',
        sessionId,
        lastKnownState,
        ...(opts.detail !== undefined ? { stateDetail: opts.detail } : {}),
        stateObservedAt: opts.now ?? now(),
        ...(opts.childPid !== undefined ? { childPid: opts.childPid } : {}),
      });
    },
    readAll(): LedgerRecord[] {
      return foldLines(readLines(path));
    },
    find(sessionId: string): LedgerRecord | undefined {
      return foldLines(readLines(path)).find((r) => r.sessionId === sessionId);
    },
    compact(): void {
      const current = foldLines(readLines(path));
      const tmp = `${path}.tmp.${process.pid}.${now()}`;
      const body = current
        .map((r) => JSON.stringify({ v: 1, type: 'record', record: r } satisfies LedgerLine))
        .join('\n');
      // write + chmod + rename: an in-flight reader never sees a half-written file, and the mode
      // survives the rename on every POSIX fs.
      writeFileSync(tmp, body + (body ? '\n' : ''), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

function writeLine(path: string, line: LedgerLine): void {
  const existed = existsSync(path);
  appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 });
  // Freshly created: tighten the mode. appendFileSync honors the mode only on create, but a file
  // that already existed might have a wider mode set elsewhere — leave the operator in control.
  if (!existed) chmodSync(path, 0o600);
}

function readLines(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (!text) return [];
  const out: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      // Skip a malformed line rather than hard-failing: a crashed-mid-append writer may have
      // left a partial. The next compaction will clear it; readers stay available in the meantime.
      continue;
    }
    const l = line as LedgerLine;
    if (l?.v === 1 && (l.type === 'record' || l.type === 'update')) out.push(l);
  }
  return out;
}

function foldLines(lines: LedgerLine[]): LedgerRecord[] {
  const byId = new Map<string, LedgerRecord>();
  for (const line of lines) {
    if (line.type === 'record') {
      byId.set(line.record.sessionId, { ...line.record });
    } else {
      const existing = byId.get(line.sessionId);
      // Ignore orphaned updates: a `record` must have come first for the update to mean anything.
      // This can happen if a reader starts between a crash and a compaction; next compaction cleans.
      if (!existing) continue;
      existing.lastKnownState = line.lastKnownState;
      existing.stateObservedAt = line.stateObservedAt;
      if (line.stateDetail !== undefined) existing.stateDetail = line.stateDetail;
      else delete existing.stateDetail;
      if (line.childPid !== undefined) existing.childPid = line.childPid;
    }
  }
  // Order: by submittedAt so `subagents` shows oldest-first (= dispatch order on this ledger).
  return [...byId.values()].sort((a, b) => a.submittedAt - b.submittedAt);
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Touch the file so `readAll` on a fresh install does not error on a missing path. */
export function initLedger(path: string): void {
  ensureParentDir(path);
  if (!existsSync(path)) {
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
    chmodSync(path, 0o600);
  }
}
