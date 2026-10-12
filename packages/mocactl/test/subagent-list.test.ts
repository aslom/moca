import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdSubagents, type SubagentsOptions } from '../src/subagent.js';
import { openLedger, type LedgerRecord } from '../src/core/subagent-ledger.js';
import { LeafTransport } from '../src/transport/leaf-turn.js';

function makeRt(scratch: string) {
  const cp = { mintSessionToken: vi.fn(async () => ({ token: 'tok', expiresAt: 9 })) };
  const harness = { baseUrl: vi.fn(async () => 'https://harness.test') };
  return {
    cp,
    harness,
    auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
    paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
    now: () => 10_000,
    fetchImpl: fetch,
  } as any;
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

function fakeTransport(resps: Record<string, any>): LeafTransport {
  return {
    readLeafState: vi.fn(async (sid: string) => {
      if (!(sid in resps)) throw new Error('unexpected sid');
      return resps[sid];
    }),
  } as unknown as LeafTransport;
}

const seedRecord = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  sessionId: 's1',
  envelope: { kind: 'prompt', prompt: 'p' },
  submittedAt: 1,
  lastKnownState: 'running',
  stateObservedAt: 1,
  ...over,
});

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'subagents-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const base = (over: Partial<SubagentsOptions> = {}): SubagentsOptions => ({
  json: false,
  ...over,
});

/* --- empty state --- */

describe('cmdSubagents — empty state', () => {
  it("prints a 'no subagents' message to stderr and returns success (not an error)", async () => {
    const rt = makeRt(scratch);
    const { io, err } = makeIo();
    const r = await cmdSubagents(rt, io, base({ transport: fakeTransport({}) }));
    expect(r).toBe(0);
    expect(err.join('\n')).toContain('no subagents');
  });

  it('--json empty case emits {"subagents":[]} on stdout (so scripts can rely on the shape)', async () => {
    const rt = makeRt(scratch);
    const { io, out } = makeIo();
    const r = await cmdSubagents(rt, io, base({ json: true, transport: fakeTransport({}) }));
    expect(r).toBe(0);
    expect(JSON.parse(out[0]!.trim())).toEqual({ subagents: [] });
  });
});

/* --- state resolution across the ledger + /runs/status join --- */

describe('cmdSubagents — joined view', () => {
  it("promotes a 'running' ledger row with alive-pid to 'running' honest state and persists it", async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'alive', childPid: process.pid }));
    const transport = fakeTransport({ alive: 'queued' });
    const { io, out } = makeIo();
    const r = await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    expect(r).toBe(0);
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents).toHaveLength(1);
    expect(parsed.subagents[0]).toMatchObject({ sessionId: 'alive', state: 'running' });
  });

  it("resolves 'queued' + dead child past grace to 'unknown', not left as 'queued'", async () => {
    // Set `now` to well past the stateObservedAt + grace window so the dead-child branch is
    // reached (DEFAULT_UNKNOWN_GRACE_MS is 60s; use a 10 000 000ms gap to be unambiguous).
    const rt = makeRt(scratch);
    rt.now = () => 10_000_000;
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    // Pid 2^31-1 is almost certainly not alive on any dev machine.
    ledger.append(seedRecord({ sessionId: 'gone', childPid: 0x7fffffff, stateObservedAt: 1 }));
    const transport = fakeTransport({ gone: 'queued' });
    const { io, out } = makeIo();
    const r = await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    expect(r).toBe(0);
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents[0].state).toBe('unknown');
  });

  it('passes through a terminal server body as its honest state (done for responded/done/solved)', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'd1', envelope: { kind: 'prompt', prompt: 'p' } }));
    const transport = fakeTransport({ d1: { status: 'solved', patch: 'diff\n' } });
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents[0].state).toBe('done');
  });

  it("filters by --tag so a parent agent's own subagents are reportable in isolation", async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'mine', tag: 'parent-a', childPid: process.pid }));
    ledger.append(seedRecord({ sessionId: 'theirs', tag: 'other', childPid: process.pid }));
    const transport = fakeTransport({ mine: 'queued', theirs: 'queued' });
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, tag: 'parent-a', ledger, transport }));
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents.map((s: any) => s.sessionId)).toEqual(['mine']);
  });

  it('keeps going when one row fails to read status (other rows must still be reported)', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'ok', childPid: process.pid }));
    ledger.append(seedRecord({ sessionId: 'bad', submittedAt: 2, childPid: process.pid }));
    const transport = {
      readLeafState: vi.fn(async (sid: string) => {
        if (sid === 'bad') throw new Error('status read failed');
        return { status: 'responded', text: 'done' };
      }),
    } as unknown as LeafTransport;
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents.map((s: any) => [s.sessionId, s.state])).toEqual([
      ['ok', 'done'],
      ['bad', 'unknown'],
    ]);
  });

  it("non-JSON output is an aligned table with a header row (matches 'mocactl sessions' shape)", async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 's1', tag: 'tag-a', bundle: 'sha256:'.padEnd(71, 'a') }));
    const transport = fakeTransport({ s1: { status: 'responded', text: 'ok' } });
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ ledger, transport }));
    const stdout = out.join('');
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines[0]).toContain('SESSION');
    expect(lines[0]).toContain('STATE');
    // At least one data row.
    expect(lines[1]).toContain('s1');
    expect(lines[1]).toContain('done');
  });
});
