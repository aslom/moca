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
  // `now` is monotonic across the retry loop so the wall budget actually advances with each
  // iteration. Default `sleep` is a no-op (tests don't wait for real seconds); override per test
  // when a saturated-retry case needs the wall clock to move.
  let t = 10_000;
  return {
    cp: {},
    harness: { baseUrl: async () => 'https://harness.test' },
    auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
    paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
    endpoints: { controlPlaneUrl: undefined, harnessUrl: undefined },
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
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

/* --- retryable path: saturation retries then records a terminal row --- */

describe('runSpawnWorker — sync 503 saturated retries with bounded budget', () => {
  // The transport surfaces 503 as a thrown ApiError (that is where errorFromResponse maps it);
  // import ApiError locally so each test matches the shape the worker's catch block checks.
  it('retries up to 3 times honoring Retry-After, then records failed with the saturated detail', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        throw new ApiError('harness', 503, 'saturated', 'pool full', 1);
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(1);
    // Three attempts: initial + 2 retries. The fourth would exceed the attempt budget.
    expect((transport.submitLeafTurn as any).mock.calls.length).toBe(3);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('failed');
    expect(row.stateDetail).toBe('saturated — exhausted retries');
  });

  it('succeeds on a retry if the pool frees up (no terminal failed row recorded)', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const rt = makeRt(scratch);
    seedLedgerRow(rt.paths.subagentsFile);
    let calls = 0;
    const transport = {
      submitLeafTurn: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new ApiError('harness', 503, 'saturated', 'pool full', 0);
        return { status: 'responded', text: 'ok' } as LeafResultBody;
      }),
    } as unknown as LeafTransport;
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(0);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
  });

  // End-to-end: drive through the real LeafTransport + errorFromResponse so a server-shaped 503
  // body `{status:'failed', reason:'saturated'}` becomes an ApiError the retry loop recognizes.
  // This is what guards against the "retry loop silently never fires in production" failure mode:
  // if errorFromResponse ever stops folding `body.reason` into `code`, this test fails.
  it('end-to-end: a real 503 body drives the retry loop (not just a hand-built ApiError)', async () => {
    let hits = 0;
    const fakeFetch = vi.fn(async (url: string | URL) => {
      hits += 1;
      if (hits <= 1) {
        return new Response(JSON.stringify({ status: 'failed', reason: 'saturated' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ status: 'responded', text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const rt = makeRt(scratch, { fetchImpl: fakeFetch as unknown as typeof fetch });
    seedLedgerRow(rt.paths.subagentsFile);
    const { LeafTransport: LT } = await import('../src/transport/leaf-turn.js');
    const transport = new LT(rt.harness, rt.fetchImpl);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({ sessionId: 'sess-abc', token: 'tok', envelope: ENV }),
      transport,
    });
    expect(r).toBe(0);
    expect(hits).toBe(2);
    const row = openLedger(rt.paths.subagentsFile).readAll()[0]!;
    expect(row.lastKnownState).toBe('done');
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

  it("overrides a child-side DiscoveringHarness so the parent's resolved URL wins", async () => {
    // The failure mode this pins: the child's own env/config.json points buildRuntime at a
    // DIFFERENT control plane, so wire() built a DiscoveringHarness that would resolve to the
    // wrong harness. The forwarded `harnessUrl` must still be applied — not skipped on the
    // "rt.harness is already truthy" branch, which was the earlier bug.
    const fetchCalls: string[] = [];
    const fakeFetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ status: 'responded', text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const rt = makeRt(scratch, {
      // Pre-wired to a stale harness — this is what the child's buildRuntime would have produced.
      harness: { baseUrl: async () => 'https://stale.test' },
      endpoints: { controlPlaneUrl: 'https://cp.test', harnessUrl: undefined },
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    seedLedgerRow(rt.paths.subagentsFile);
    const r = await runSpawnWorker(rt, {
      readStdin: payloadStdin({
        sessionId: 'sess-abc',
        token: 'tok',
        envelope: ENV,
        harnessUrl: 'https://harness.correct',
      }),
    });
    expect(r).toBe(0);
    // The POST landed on the forwarded URL, not the pre-wired stale one.
    expect(fetchCalls[0]).toBe('https://harness.correct/v1/runs');
  });
});
