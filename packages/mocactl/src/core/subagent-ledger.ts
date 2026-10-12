/**
 * Client-side ledger of spawned subagents. Stored at $XDG_STATE_HOME/mocactl/subagents.jsonl
 * (mode 0600). Each line is a `record` (initial write) or an `update` (state delta); `readAll`
 * folds updates onto records by sessionId. Concurrent appends stay atomic because each line
 * is written with a single `O_APPEND` write on a local filesystem — no explicit lock. The
 * 64 KiB prompt cap keeps every line short enough to fit one write. `compact` is a whole-file
 * rewrite via `.tmp` + rename and is not called automatically today; a future trigger is
 * tracked under the subagent-commands spec's Scope section.
 */
import {
  closeSync,
  constants as fsConst,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { HonestState } from '../transport/leaf-turn.js';

export interface LedgerEnvelope {
  /**
   * Full dispatch envelope — needed for a future `approve/reject` to resend with a decision.
   * `kind` is widened to `string` on read so a ledger line written by an older binary (e.g.
   * `kind: 'converge'`) still deserializes without a type lie; new writes stay within the
   * narrower `'prompt' | 'solve'` set.
   */
  kind: string;
  prompt?: string;
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
      // Atomic swap via rename: a reader opens either the old file or the new one.
      writeFileSync(tmp, body + (body ? '\n' : ''), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

function writeLine(path: string, line: LedgerLine): void {
  // O_NOFOLLOW + the mode on the syscall itself is the TOCTOU-free equivalent of
  // existsSync→append→chmod: a symlink races to ELOOP instead of being followed.
  const flags = fsConst.O_WRONLY | fsConst.O_CREAT | fsConst.O_APPEND | fsConst.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    writeSync(fd, JSON.stringify(line) + '\n');
  } finally {
    closeSync(fd);
  }
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
      continue; // crashed-mid-append partial; a later `compact` would clear it.
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
      if (!existing) continue; // orphaned update — ignore (a later `compact` would drop it).

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
  // O_CREAT with the mode on the syscall; O_NOFOLLOW refuses a symlinked state file.
  const flags = fsConst.O_WRONLY | fsConst.O_CREAT | fsConst.O_APPEND | fsConst.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  closeSync(fd);
}
