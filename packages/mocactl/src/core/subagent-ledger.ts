/**
 * Client-side ledger of spawned subagents. Stored at $XDG_STATE_HOME/mocactl/subagents.jsonl
 * (mode 0600). Each line is a `record` (initial write) or an `update` (state delta); `readAll`
 * folds updates onto records by sessionId. Concurrent appends stay atomic under POSIX
 * PIPE_BUF (4 KiB) without an explicit lock. `compact` is the one whole-file write and uses
 * `.tmp` + rename.
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
  /** When this state was last written, in epoch ms. */
  stateObservedAt: number;
}

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
  /** Rewrites the file as folded records. Not called on the hot path. */
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
      // Atomic swap: readers never see a half-written file.
      writeFileSync(tmp, body + (body ? '\n' : ''), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

function writeLine(path: string, line: LedgerLine): void {
  const existed = existsSync(path);
  appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 });
  // Mode only applies on create; existing files keep whatever the operator set.
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
      continue; // crashed-mid-append partial; next compact clears it.
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
      if (!existing) continue; // orphaned update — ignore until next compact

      existing.lastKnownState = line.lastKnownState;
      existing.stateObservedAt = line.stateObservedAt;
      if (line.stateDetail !== undefined) existing.stateDetail = line.stateDetail;
      else delete existing.stateDetail;
      if (line.childPid !== undefined) existing.childPid = line.childPid;
    }
  }
  // Oldest-first by dispatch time.
  return [...byId.values()].sort((a, b) => a.submittedAt - b.submittedAt);
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Touch the file so `readAll` on a fresh install returns []. */
export function initLedger(path: string): void {
  ensureParentDir(path);
  if (!existsSync(path)) {
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
    chmodSync(path, 0o600);
  }
}
