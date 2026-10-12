/**
 * Client-side submit + status-read for data-plane `/runs`. One place for leaf dispatch, so a
 * later async-turn transport can replace the backend without changing spawn/subagents/get.
 */
import { ApiError, errorFromResponse, networkError } from '../api/errors.js';
import { trimTrailingSlashes } from '../api/url.js';

/**
 * Mirrors harness/src/run-leaf.ts `LeafEnvelope`; this client sends `prompt` and `converge`
 * kinds. `item` is required by the verdict path (converge); harness ignores it on prompt.
 */
export interface LeafEnvelope {
  sessionId: string;
  kind: 'prompt' | 'converge';
  prompt?: string;
  item?: { item_id: string; file: string; pattern: string; require_approval?: boolean };
  repoUrl?: string;
  ref?: string;
  configRef?: string;
}

/** Shape returned by `POST /runs` (sync) and `GET /runs/status`, flattened across result kinds. */
export interface LeafResultBody {
  status: 'responded' | 'done' | 'solved' | 'paused' | 'failed' | 'queued';
  text?: string;
  verdict?: unknown;
  patch?: string;
  reason?: string;
  message?: string;
  gateId?: number;
  gate?: { summary: string; proposed_action: string };
  usage?: Record<string, number>;
}

/**
 * Honest state surfaced to users. Resolves the server's three-way `queued` (still running /
 * never recorded / aged out) with child-pid liveness and a grace window.
 */
export type HonestState = 'running' | 'done' | 'failed' | 'paused' | 'unknown';

export interface StateView {
  state: HonestState;
  /** Operator-facing hint for non-done terminal states (e.g. the failure reason). */
  detail?: string;
  /** Carried through when the server has a terminal record; absent on `running`/`unknown`. */
  result?: LeafResultBody;
}

/** How long after a child dies we wait before reporting `unknown`, to cover result-write races. */
export const DEFAULT_UNKNOWN_GRACE_MS = 60_000;

export function isTerminalState(state: HonestState): boolean {
  return state === 'done' || state === 'failed' || state === 'paused';
}

/** Map a terminal `/runs/status` body to a state view. */
export function terminalFromBody(body: LeafResultBody): StateView {
  if (body.status === 'responded' || body.status === 'done' || body.status === 'solved') {
    return { state: 'done', result: body };
  }
  if (body.status === 'paused') return { state: 'paused', detail: 'gate requested', result: body };
  if (body.status === 'failed')
    return { state: 'failed', detail: body.reason ?? body.message, result: body };
  return { state: 'unknown', detail: `server returned status '${body.status}'`, result: body };
}

/** Minimum interface so a test can inject a fake without a real HarnessClient. */
export interface LeafHarness {
  baseUrl(): Promise<string>;
}

export class LeafTransport {
  constructor(
    private readonly harness: LeafHarness,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** POST /runs with the session's token. Returns the sync-path result body. */
  async submitLeafTurn(
    envelope: LeafEnvelope,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<LeafResultBody> {
    const base = trimTrailingSlashes(await this.harness.baseUrl());
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(envelope),
        signal,
      });
    } catch (err) {
      throw networkError('harness', err);
    }
    if (!res.ok) throw await errorFromResponse('harness', res);
    try {
      return (await res.json()) as LeafResultBody;
    } catch (err) {
      throw new ApiError('harness', 0, 'invalid_body', 'the harness returned non-JSON for /runs');
    }
  }

  /** GET /runs/status. Returns the body, or 'queued' / 'not_found'. */
  async readLeafState(
    sessionId: string,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<LeafResultBody | 'queued' | 'not_found'> {
    const base = trimTrailingSlashes(await this.harness.baseUrl());
    const url = `${base}/runs/status?sessionId=${encodeURIComponent(sessionId)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${sessionToken}` },
        signal,
      });
    } catch (err) {
      throw networkError('harness', err);
    }
    if (res.status === 404) return 'not_found';
    if (!res.ok) throw await errorFromResponse('harness', res);
    let body: LeafResultBody;
    try {
      body = (await res.json()) as LeafResultBody;
    } catch {
      throw new ApiError(
        'harness',
        0,
        'invalid_body',
        'the harness returned non-JSON for /runs/status',
      );
    }
    return body.status === 'queued' ? 'queued' : body;
  }
}

export interface ChildLiveness {
  alive: boolean;
  /** When we last checked this child's liveness, in epoch ms. */
  observedAt: number;
}

/** Map a raw status + child liveness into a HonestState. */
export function mapHonestState(
  raw: LeafResultBody | 'queued' | 'not_found',
  live: ChildLiveness,
  now: number,
  graceMs: number = DEFAULT_UNKNOWN_GRACE_MS,
): StateView {
  if (raw === 'not_found') return { state: 'unknown', detail: 'session not found' };
  if (raw === 'queued') {
    if (live.alive) return { state: 'running' };
    // Grace: a just-exited child's result write may still be propagating.
    if (now - live.observedAt < graceMs)
      return { state: 'running', detail: 'child exited; waiting for result' };
    return { state: 'unknown', detail: 'child exited and no result recorded' };
  }
  return terminalFromBody(raw);
}
