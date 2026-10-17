import { randomBytes } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { credentials, Metadata, status, type ServiceError } from '@grpc/grpc-js';
import { SandboxExecClient, Stream, type ExecEvent } from './gen/sandbox/v1/sandbox.js';

/**
 * The sandbox/v1 exec client for SBX0's clients (spec §6.5, §7): TLS to the exec Route, keepalive
 * under a load balancer's idle cut, and a short-lived sandbox token kept fresh through `token()`.
 *
 * The one retry rule: a token refusal (UNAUTHENTICATED) is retried once, with a forced fresh token,
 * ONLY if no event arrived. A command that started is never run twice: any failure after the first
 * event -- a dropped connection included -- is surfaced as an error.
 */
export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** < 0: killed by a signal (an abort, a timeout, a crash). */
  exitCode: number;
  /** stdout hit the worker's 8 MiB cap. */
  truncated: boolean;
  /**
   * Set when the worker timed the command out (`ExecError{"timeout:<n>"}`): the `<n>` it reports.
   * `exitCode` is then < 0. A timeout is the command's outcome, not a machinery failure.
   */
  timedOutS?: number;
  /** Set when the requested `timeoutS` was cut to fit the sandbox token's life (spec §6.5). */
  capped?: boolean;
}

/**
 * What went wrong, when it was not the command:
 * - `machinery`: VM boot, worker gone, a dropped connection, any other ExecError or non-OK status;
 * - `busy`: the relay's per-sandbox in-flight cap (RESOURCE_EXHAUSTED "sandbox busy"). Nothing ran;
 * - `template_busy`: the template's shared worker is saturated (`busy: queue full`, `memory-budget:`
 *   or `max-runs:`). Nothing ran;
 * - `token_expired`: the relay cancelled the Exec at its token's `exp` (DEADLINE_EXCEEDED).
 */
export type ExecFailureKind = 'machinery' | 'busy' | 'template_busy' | 'token_expired';

/** The machinery failed: NOT the command's outcome. `kind` says how (see `ExecFailureKind`). */
export class ExecMachineryError extends Error {
  constructor(
    message: string,
    readonly grpcCode?: number,
    readonly kind: ExecFailureKind = 'machinery',
  ) {
    super(message);
    this.name = 'ExecMachineryError';
  }
}

/** The relay refused the call (token, worker, workspace) after the one permitted refresh. */
export class ExecRefusedError extends Error {
  constructor(
    message: string,
    readonly grpcCode: number,
  ) {
    super(message);
    this.name = 'ExecRefusedError';
  }
}

/** What the connection asks of its token source before an Exec. */
export interface TokenRequest {
  /** Mint a new token even if the held one is still valid (after an UNAUTHENTICATED). */
  force: boolean;
  /**
   * The token must have at least this many seconds left, or the source mints a new one. It is
   * `timeoutS + 60`, so for a defaulted timeout it equals the token's whole lifetime: such an Exec
   * gets a token minted for it. The connection's first ask is 60, to learn the lifetime.
   */
  minValidS: number;
}

export interface SandboxTokenGrant {
  token: string;
  /** The token's `exp`, in epoch seconds; 0 if it cannot be read. */
  expiresAt: number;
  /** The token's `exp − iat` in seconds; 0 if it cannot be read. */
  lifetimeS: number;
}

export type TokenFn = (o: TokenRequest) => Promise<SandboxTokenGrant>;

export interface ExecConnOptions {
  addr: string;
  tls: boolean;
  /** PEM of a self-issued exec certificate, trusted IN ADDITION to the system roots. */
  caPem?: string;
  sandboxId: string;
  workspaceKey: string;
  token: TokenFn;
  keepaliveMs?: number;
  /** The clock, in epoch milliseconds (tests). */
  now?: () => number;
}

export interface ExecOptions {
  stdin?: Uint8Array;
  /**
   * Seconds. Defaults to, and is capped at, the token lifetime minus 60 s (120 s when the lifetime
   * cannot be read), and is cut further to what the token has left, minus 60 s.
   */
  timeoutS?: number;
  signal?: AbortSignal;
}

export type Exec = (command: string, opts?: ExecOptions) => Promise<ExecResult>;

const MAX_MESSAGE = 16 * 1024 * 1024;
export const CLIENT_CHANNEL_OPTIONS: Record<string, number> = {
  'grpc.max_receive_message_length': MAX_MESSAGE,
  'grpc.max_send_message_length': MAX_MESSAGE,
  'grpc.keepalive_time_ms': 20_000,
  'grpc.keepalive_timeout_ms': 10_000,
  'grpc.keepalive_permit_without_calls': 1,
};

/**
 * Seconds of token life kept spare beyond an Exec's timeout, so the worker's own timeout fires
 * before the relay cancels the Exec at the token's `exp` (spec §3.6, §6.5).
 */
export const TOKEN_MARGIN_S = 60;
/** The timeout when the token's lifetime cannot be read. */
const FALLBACK_TIMEOUT_S = 120;

/** The worker's ExecError for a command that ran out of `timeout_s`. */
const TIMEOUT_MESSAGE = /^timeout:(\d+)$/;
/** The worker's refusals when the template's shared worker is saturated (spec §6.4). */
const TEMPLATE_BUSY = /^(?:busy: queue full|memory-budget:|max-runs:)/;

/** Random, unique per call, and below 2^53: the relay decodes the uint64 as a JavaScript number. */
export function newReqId(): number {
  return Number(randomBytes(8).readBigUInt64BE() >> 11n);
}

class NotStarted extends Error {}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export class SandboxExecConn {
  private readonly client: SandboxExecClient;
  private readonly now: () => number;
  /** The last readable token lifetime, so later Execs ask for exactly the life they need. */
  private lifetimeS = 0;

  constructor(private readonly o: ExecConnOptions) {
    const creds = o.tls
      ? credentials.createSsl(
          o.caPem ? Buffer.from([...rootCertificates, o.caPem].join('\n')) : null,
        )
      : credentials.createInsecure();
    this.client = new SandboxExecClient(o.addr, creds, {
      ...CLIENT_CHANNEL_OPTIONS,
      ...(o.keepaliveMs ? { 'grpc.keepalive_time_ms': o.keepaliveMs } : {}),
    });
    this.now = o.now ?? Date.now;
  }

  exec: Exec = async (command, opts = {}) => {
    const requested = opts.timeoutS;
    if (requested !== undefined && !(Number.isFinite(requested) && requested > 0)) {
      throw new RangeError(`timeoutS must be a positive number of seconds, got ${requested}`);
    }
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    const { grant, timeoutS, capped } = await this.prepare(
      requested === undefined ? undefined : Math.ceil(requested),
    );
    // Unique within the sandbox, and reused for the one retry: the relay namespaces it per sandbox.
    const reqId = newReqId();
    const finish = (r: ExecResult): ExecResult => (capped ? { ...r, capped: true } : r);
    try {
      return finish(await this.once(command, opts, reqId, timeoutS, grant.token));
    } catch (err) {
      if (!(err instanceof NotStarted)) throw err;
    }
    // The token was refused before anything ran: refresh once and retry.
    const fresh = await this.o.token({ force: true, minValidS: timeoutS + TOKEN_MARGIN_S });
    this.learn(fresh);
    try {
      return finish(await this.once(command, opts, reqId, timeoutS, fresh.token));
    } catch (again) {
      if (again instanceof NotStarted) {
        throw new ExecRefusedError(
          `${again.message} (after one token refresh)`,
          status.UNAUTHENTICATED,
        );
      }
      throw again;
    }
  };

  close = (): void => {
    this.client.close();
  };

  private learn(g: SandboxTokenGrant): void {
    if (g.lifetimeS > 0) this.lifetimeS = g.lifetimeS;
  }

  /** Seconds the grant has left by this machine's clock; undefined if its expiry is unreadable. */
  private left(g: SandboxTokenGrant): number | undefined {
    return g.expiresAt > 0 ? g.expiresAt - this.now() / 1000 : undefined;
  }

  /**
   * Token freshness (spec §6.5): the token to send, the timeout to send, and whether a requested
   * timeout was cut. `timeout_s` defaults to, and is capped at, the token lifetime minus 60 s, and
   * the token must have the timeout plus 60 s left, or the relay would cancel the Exec at `exp`.
   */
  private async prepare(requested: number | undefined) {
    const timeoutFor = (life: number) => {
      if (!life) return { timeoutS: requested ?? FALLBACK_TIMEOUT_S, capped: false };
      const cap = Math.max(1, life - TOKEN_MARGIN_S);
      return requested === undefined
        ? { timeoutS: cap, capped: false }
        : { timeoutS: Math.min(requested, cap), capped: requested > cap };
    };
    let grant: SandboxTokenGrant;
    let t: { timeoutS: number; capped: boolean };
    if (this.lifetimeS) {
      t = timeoutFor(this.lifetimeS);
      grant = await this.o.token({ force: false, minValidS: t.timeoutS + TOKEN_MARGIN_S });
      this.learn(grant);
    } else {
      // The lifetime is learnt from the first token; then ask once more only if it falls short.
      grant = await this.o.token({ force: false, minValidS: TOKEN_MARGIN_S });
      this.learn(grant);
      t = timeoutFor(grant.lifetimeS);
      // ceil, as below: a token minted within the last second is as fresh as one can be.
      const left = this.left(grant);
      if (left !== undefined && Math.ceil(left) < t.timeoutS + TOKEN_MARGIN_S) {
        grant = await this.o.token({ force: false, minValidS: t.timeoutS + TOKEN_MARGIN_S });
        this.learn(grant);
      }
    }
    // Even a fresh token may not cover it: one minted near the sandbox's expiry is shorter, and
    // clocks differ. Then the timeout is cut to what the token has left, less 60 s.
    const left = this.left(grant);
    if (left !== undefined && t.timeoutS + TOKEN_MARGIN_S > left) {
      // ceil: a token minted this instant keeps its full cap.
      const cut = Math.max(1, Math.ceil(left) - TOKEN_MARGIN_S);
      if (cut < t.timeoutS) {
        t = { timeoutS: cut, capped: t.capped || requested !== undefined };
      }
    }
    return { grant, ...t };
  }

  private once(
    command: string,
    opts: ExecOptions,
    reqId: number,
    timeoutS: number,
    token: string,
  ): Promise<ExecResult> {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const md = new Metadata();
    md.set('authorization', `Bearer ${token}`);
    const call = this.client.exec(
      {
        sandboxId: this.o.sandboxId,
        exec: {
          reqId,
          command,
          stdin: opts.stdin ? new Uint8Array(opts.stdin) : new Uint8Array(),
          timeoutS,
          streaming: true,
          workspaceKey: this.o.workspaceKey,
        },
      },
      md,
    );
    // A call can report both 'error' and 'end' on some grpc-js paths; a settled promise ignores
    // the second, so both handlers only resolve or reject.
    return new Promise<ExecResult>((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let started = false;
      let aborted = false;
      let end: { exitCode: number; truncated: boolean } | undefined;
      let execError: string | undefined;
      const result = (r: { exitCode: number; truncated: boolean; timedOutS?: number }) => ({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        ...r,
      });
      const onAbort = () => {
        aborted = true;
        // The relay also aborts at the worker when it sees the cancel; this says so explicitly.
        this.client.abort(
          { sandboxId: this.o.sandboxId, reqId },
          md,
          { deadline: Date.now() + 10_000 },
          () => {},
        );
        call.cancel();
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => signal?.removeEventListener('abort', onAbort);

      /** A worker message (in-stream ExecError, or the status details) that is not a failure. */
      const outcomeOf = (message: string | undefined) => {
        const m = message === undefined ? null : TIMEOUT_MESSAGE.exec(message);
        return m ? result({ exitCode: -1, truncated: false, timedOutS: Number(m[1]) }) : undefined;
      };
      const workerFailure = (message: string, code?: number) =>
        TEMPLATE_BUSY.test(message)
          ? new ExecMachineryError(`template busy: ${message}`, code, 'template_busy')
          : new ExecMachineryError(`sandbox failure: ${message || 'exec failed'}`, code);

      call.on('data', (ev: ExecEvent) => {
        started = true;
        if (ev.chunk) {
          (ev.chunk.stream === Stream.STREAM_STDERR ? err : out).push(Buffer.from(ev.chunk.data));
        } else if (ev.end) {
          end = { exitCode: ev.end.exitCode, truncated: ev.end.truncated };
        } else if (ev.error) {
          execError = ev.error.message ?? '';
        }
      });
      call.on('error', (e: ServiceError) => {
        done();
        if (aborted) return;
        // The command's outcome arrived; whatever the status says after it is not the command's.
        if (end) return resolve(result(end));
        const details = e.details || e.message;
        const outcome = outcomeOf(execError ?? details);
        if (outcome) return resolve(outcome);
        if (execError !== undefined) return reject(workerFailure(execError, e.code));
        if (!started && e.code === status.UNAUTHENTICATED) return reject(new NotStarted(details));
        if (!started && e.code === status.PERMISSION_DENIED) {
          return reject(new ExecRefusedError(details, e.code));
        }
        if (e.code === status.RESOURCE_EXHAUSTED && details.startsWith('sandbox busy')) {
          return reject(new ExecMachineryError(details, e.code, 'busy'));
        }
        if (
          e.code === status.DEADLINE_EXCEEDED &&
          details.startsWith('sandbox token expired during the Exec')
        ) {
          return reject(
            new ExecMachineryError(
              `${details}: the command outlived its sandbox token and was cancelled`,
              e.code,
              'token_expired',
            ),
          );
        }
        if (TEMPLATE_BUSY.test(details)) return reject(workerFailure(details, e.code));
        reject(
          new ExecMachineryError(
            `sandbox failure: ${status[e.code] ?? e.code}: ${details}`,
            e.code,
          ),
        );
      });
      call.on('end', () => {
        done();
        if (aborted) return;
        if (end) return resolve(result(end));
        const outcome = outcomeOf(execError);
        if (outcome) return resolve(outcome);
        if (execError !== undefined) return reject(workerFailure(execError));
        reject(
          new ExecMachineryError('sandbox failure: the exec stream ended without an End event'),
        );
      });
    });
  }
}
