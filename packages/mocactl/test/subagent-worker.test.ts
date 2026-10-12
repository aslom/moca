import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpawnWorker, type SpawnWorkerPayload } from '../src/subagent.js';
import { openLedger } from '../src/core/subagent-ledger.js';
import {
  LeafTransport,
  type LeafEnvelope,
  type LeafResultBody,
} from '../src/transport/leaf-turn.js';

/**
 * The detached worker owns the terminal state the parent cannot write: it's the one that holds
 * the `POST /v1/runs` call open and sees the final body. These tests pin that every exit path
 * — happy, error, early-return — leaves the ledger in a state `subagents` can read without a
 * stuck `running` row.
 */

const ENV: LeafEnvelope = {
  sessionId: 'sess-abc',
  kind: 'prompt',
  prompt: 'hi',
  configRef: 'sha256:' + 'a'.repeat(64),
};

function makeRt(scratch: string, over: Partial<any> = {}): any {
  return {
    cp: {},
    harness: { baseUrl: async () => 'https://harness.test' },
    auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
    paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
    endpoints: { controlPlaneUrl: undefined, harnessUrl: undefined },
    now: () => 10_000,
    fetchImpl: fetch,
    config: {},
    ...over,
  };
}

function payloadStdin(payload: Partial<SpawnWorkerPayload>): () => Promise<string> {
  return async () => JSON.stringify(payload);
}

function seedLedgerRow(ledgerPath: string, sessionId = 'sess-abc') {
  const ledger = openLedger(ledgerPath);
  ledger.append({
    sessionId,
    envelope: { kind: 'prompt', prompt: 'hi' },
    submittedAt: 1,
    lastKnownState: 'running',
    stateObservedAt: 1,
  });
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'worker-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/* --- happy path --- */

describe('runSpawnWorker — happy path', () => {
  it('on a terminal responded body, marks the ledger done and exits 0', async () => {
    const rt = makeRt(scratch);
    const ledgerPath = rt.paths.subagentsFile;
    seedLedgerRow(ledgerPath);
    const transport = {
      submitLeafTurn: vi.fn(
        async () => ({ status: 'responded', text: 'hi back' }) as LeafResultBody,
      ),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(0);
    const row = openLedger(ledgerPath).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
    // The envelope the worker sent carries configRef — this is M1's point. Pin it here too.
    expect(transport.submitLeafTurn).toHaveBeenCalledWith(
      expect.objectContaining({ configRef: ENV.configRef }),
      'tok',
    );
  });
});

/* --- failure paths that must still write a terminal ledger line --- */

describe('runSpawnWorker — terminal ledger writes on every non-retry exit', () => {
  it('on submitLeafTurn throwing, marks the ledger failed with the error message', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toContain('socket hang up');
  });

  it('on a terminal failed body, mirrors the server reason into the ledger detail', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(
        async () =>
          ({ status: 'failed', reason: 'bad_inputs', message: 'empty prompt' }) as LeafResultBody,
      ),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toBe('bad_inputs');
  });

  it('on no harness URL and no forwarded endpoints, writes a failed ledger line (never silent)', async () => {
    const rt = makeRt(scratch, { harness: undefined });
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
    });
    expect(r).toBe(2);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toContain('harness URL');
  });
});

/* --- retryable path: saturation stays non-terminal --- */

describe('runSpawnWorker — sync 503 saturated is retryable, not terminal', () => {
  it("leaves the ledger row 'running' and exits 1 so the parent can be re-driven from /v1/runs/status", async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(
        async () =>
          ({ status: 'failed', reason: 'saturated', message: 'pool full' }) as LeafResultBody,
      ),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    // Row stays `running` so `subagents` re-queries /v1/runs/status next tick.
    expect(row.lastKnownState).toBe('running');
  });
});

/* --- stdin-parse failures --- */

describe('runSpawnWorker — malformed stdin', () => {
  it('on non-JSON stdin, exits 2 (no ledger write; the parent already wrote the row at spawn)', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, { readStdin: async () => 'not json' });
    expect(r).toBe(2);
    // The row the parent appended is still `running` — the worker did not advance it.
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('running');
  });

  it('on JSON missing sessionId/token, exits 2 without crashing (defensive against a parent-build drift)', async () => {
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: async () => JSON.stringify({ envelope: ENV }),
    });
    expect(r).toBe(2);
  });
});

/* --- forwarded endpoints: parent passes URLs on stdin, child rebuilds its runtime --- */

describe('runSpawnWorker — endpoint forwarding', () => {
  it('rebuilds the harness client and routes POST /v1/runs through it when the child has no endpoint flags', async () => {
    // Simulate a child spawned with no --control-plane-url and no SH_* env: rt.harness and
    // rt.endpoints are empty. The stdin payload carries the resolved URLs. We swap rt.fetchImpl
    // so the HarnessClient `applyEndpoints` builds routes its POST through the fake — proving
    // the applyEndpoints → wire → HarnessClient chain actually ran.
    const fetchCalls: string[] = [];
    const fakeFetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ status: 'responded', text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const rt = makeRt(scratch, {
      harness: undefined,
      endpoints: { controlPlaneUrl: undefined, harnessUrl: undefined },
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({
        sessionId: 'sess-abc',
        token: 'tok',
        envelope: ENV,
        harnessUrl: 'https://harness.test',
      }),
    });
    expect(r).toBe(0);
    expect(fetchCalls[0]).toBe('https://harness.test/v1/runs');
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
  });
});
