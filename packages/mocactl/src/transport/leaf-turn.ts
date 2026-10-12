/**
 * Leaf-turn transport: client-side submit + status-read for data-plane `/runs`.
 *
 * Separate from HarnessClient's `streamTurn` / `attach` (which drive the interactive `/v1/turn`
 * path) because leaf dispatch is a different wire shape: a JSON POST to `/runs` with a
 * LeafEnvelope body, a sync JSON response, and `GET /runs/status?sessionId=` to read a stored
 * record (24h TTL). This module is the one place the leaf dispatch lives, so a later async-turn
 * transport can replace the backend without touching spawn/subagents/get.
 */
import { ApiError, errorFromResponse, networkError } from '../api/errors.js';
import { trimTrailingSlashes } from '../api/url.js';

/**
 * Envelope posted to `POST /runs`. Mirrors harness/src/run-leaf.ts `LeafEnvelope`; this
 * client sends only `prompt` and `converge` kinds. `item` is required by the
 * verdict path even for prompt leaves — the harness ignores it on prompt but refuses an envelope
 * without `item` for converge. Kept flat so the submit function can serialize without reshaping.
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
 * Honest state — what spawn/subagents/get present to users. The server's
 * `queued` conflates "running on this pod", "never recorded", and "aged out" (server.ts:678-680);
 * this module resolves that ambiguity using child-pid liveness and a grace window.
 */
export type HonestState = 'running' | 'done' | 'failed' | 'paused' | 'unknown';

export interface StateView {
  state: HonestState;
  /** Operator-facing hint for non-done terminal states (e.g. the failure reason). */
  detail?: string;
  /** Carried through when the server has a terminal record; absent on `running`/`unknown`. */
  result?: LeafResultBody;
}

/**
 * Grace window after a child dies before the server's `queued` is honestly reported as
 * `unknown`. Covers two races: the child wrote the result record and exited but the write hasn't
 * propagated to `/runs/status` yet, and the child was still mid-POST when it was killed.
 */
export const DEFAULT_UNKNOWN_GRACE_MS = 60_000;

/**
 * Minimum of the two surfaces the transport needs, so a test can inject a fake without
 * standing up a real HarnessClient.
 */
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

  /**
   * GET /runs/status?sessionId=. Returns the result body or 'queued' (no record on the server
   * side) or 'not_found' (session itself unknown). The caller resolves `queued` into a honest
   * state using child liveness.
   */
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

/** Child-liveness probe sent to `mapHonestState`. */
export interface ChildLiveness {
  /** True if the detached worker pid is still alive (parent-side `kill -0` check). */
  alive: boolean;
  /** Epoch ms when the child was last confirmed alive, or when it was observed to have died. */
  observedAt: number;
}

/**
 * Map a raw status read + child-pid liveness into a HonestState. Grace lets a just-exited
 * child's result propagate before we declare `unknown`.
 */
export function mapHonestState(
  raw: LeafResultBody | 'queued' | 'not_found',
  live: ChildLiveness,
  now: number,
  graceMs: number = DEFAULT_UNKNOWN_GRACE_MS,
): StateView {
  if (raw === 'not_found') {
    // Session itself is gone (aged out or never created). Honest, not retryable.
    return { state: 'unknown', detail: 'session not found' };
  }
  if (raw === 'queued') {
    if (live.alive) return { state: 'running' };
    // Child is gone; wait out the grace before calling it unknown to avoid a race with the
    // child's result-write landing after we observed its death.
    if (now - live.observedAt < graceMs)
      return { state: 'running', detail: 'child exited; waiting for result' };
    return { state: 'unknown', detail: 'child exited and no result recorded' };
  }
  // Server has a terminal record; honest-map by status.
  if (raw.status === 'responded' || raw.status === 'done' || raw.status === 'solved') {
    return { state: 'done', result: raw };
  }
  if (raw.status === 'paused') return { state: 'paused', detail: 'gate requested', result: raw };
  if (raw.status === 'failed')
    return { state: 'failed', detail: raw.reason ?? raw.message, result: raw };
  // Server returned something we don't understand (future status). Honestly surface it.
  return {
    state: 'unknown',
    detail: `server returned status '${(raw as LeafResultBody).status}'`,
    result: raw,
  };
}
