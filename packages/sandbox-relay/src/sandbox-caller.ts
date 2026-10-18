import { status, type ServerWritableStream } from '@grpc/grpc-js';
import type { Exec, ExecEvent, ExecRequest } from '@moca/k8s-sandbox';
import type { SandboxTokenClaims } from '@moca/control-plane';
import type { Relay, RelayTimers } from './relay.js';
import { workerReqId } from './sandbox-auth.js';
import { failExecStream, grpcError, pumpExec, withReqId } from './exec-stream.js';

/** setTimeout's delay is a signed 32-bit ms count; a longer one fires at once (Node clamps to 1). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Runs `fn` once at the absolute time `deadlineMs`, re-arming across setTimeout's 24.8-day ceiling
 * so a long-lived token is never cancelled early. Returns the canceller.
 */
export function armDeadline(
  deadlineMs: number,
  fn: () => void,
  timers: RelayTimers = { setTimeout, clearTimeout: (h) => clearTimeout(h as never) },
): () => void {
  let handle: unknown;
  const arm = () => {
    const left = deadlineMs - Date.now();
    handle =
      left > MAX_TIMER_MS
        ? timers.setTimeout(arm, MAX_TIMER_MS)
        : timers.setTimeout(fn, Math.max(0, left));
  };
  arm();
  return () => timers.clearTimeout(handle);
}

/** What the sandbox caller needs from the relay server (SBX0 §3.6). */
export interface SandboxCallerOpts {
  maxInflight: number;
  /** Seconds past a token's `exp` at which its running Exec is cancelled. */
  leewayS: number;
  timers?: RelayTimers;
  /** Writes one refusal line (SBX0 §3.5). */
  refused: (call: 'exec' | 'abort', reason: string, claims?: SandboxTokenClaims) => void;
}

/**
 * The sandbox caller kind's Exec and Abort rules (SBX0 §3.6), behind the caller check: exact
 * worker and workspace, per-sandbox request ids, no Exec outliving its token, the in-flight cap,
 * and Abort only of the caller's own in-flight Exec. One per Exec server.
 */
export function makeSandboxCaller(relay: Relay, opts: SandboxCallerOpts) {
  const { maxInflight, leewayS, refused } = opts;
  // A sandbox caller may abort only an Exec its own sandbox started and that is still in flight:
  // req_ids are not secret, so without this one sandbox could kill another's command. Keyed by the
  // token's sbx and the CALLER's req_id; the entry holds where the Exec actually runs.
  const owned = new Map<string, { wrk: string; wid: number }>();
  const ownKey = (sbx: string, reqId: number) => `${sbx}\0${reqId}`;
  // Accepted, unfinished sandbox Execs per sbx (SBX0 §3.6).
  const inflight = new Map<string, number>();

  async function sandboxExec(
    call: ServerWritableStream<ExecRequest, ExecEvent>,
    claims: SandboxTokenClaims,
    sandboxId: string,
    e: Exec,
  ): Promise<void> {
    // Exact equality on both (SBX0 §3.2): never a prefix, so sbx-a cannot reach sbx-ab.
    const denied =
      sandboxId !== claims.wrk
        ? "exec not permitted: sandbox_id is not this token's worker"
        : e.workspaceKey !== claims.wsk
          ? "exec not permitted: workspace_key is not this token's workspace"
          : undefined;
    if (denied) {
      refused('exec', denied, claims);
      failExecStream(call, grpcError(status.PERMISSION_DENIED, denied));
      return;
    }
    const key = ownKey(claims.sbx, e.reqId);
    if (owned.has(key)) {
      // Refused here, not left to routeExec's collision: that would name the worker's id, and
      // this Exec's cleanup must never drop the first one's ownership entry.
      failExecStream(
        call,
        grpcError(status.ALREADY_EXISTS, `req_id ${e.reqId} already in flight for this sandbox`),
      );
      return;
    }
    const n = inflight.get(claims.sbx) ?? 0;
    if (n >= maxInflight) {
      failExecStream(
        call,
        grpcError(status.RESOURCE_EXHAUSTED, `sandbox busy: ${n} Execs already in flight`),
      );
      return;
    }
    let wid: number;
    try {
      wid = workerReqId(claims.sbx, e.reqId);
    } catch {
      failExecStream(call, grpcError(status.INVALID_ARGUMENT, 'req_id out of range'));
      return;
    }
    const entry = { wrk: sandboxId, wid };
    // No Exec outlives its token (SBX0 §3.6): at exp + leeway the worker is told to abort and
    // the call ends at once. The handler then drains the worker's acknowledgement without
    // writing it, so the slot and the ownership entry are held until the worker lets go.
    let expired = false;
    let disarm: ReturnType<typeof armDeadline> | undefined;
    try {
      owned.set(key, entry);
      inflight.set(claims.sbx, n + 1);
      disarm = armDeadline(
        (claims.exp + leewayS) * 1000,
        () => {
          if (call.cancelled) return;
          expired = true;
          relay.routeAbort(sandboxId, wid);
          failExecStream(
            call,
            grpcError(status.DEADLINE_EXCEEDED, 'sandbox token expired during the Exec'),
          );
        },
        opts.timers,
      );
      await pumpExec(
        call,
        relay,
        sandboxId,
        { ...e, reqId: wid },
        {
          // Never let the worker's id reach the caller: every frame carries the caller's own.
          toCaller: (ev) => withReqId(ev, e.reqId),
          // routeExec's collision message names the id it collided on; the caller sees its own.
          mapError: (err) => {
            const m = err.message.split(String(wid)).join(String(e.reqId));
            if (m === err.message) return err;
            const code = (err as { code?: unknown }).code;
            return typeof code === 'number' ? grpcError(code, m) : new Error(m);
          },
          over: () => expired,
        },
      );
    } finally {
      if (disarm) disarm();
      if (owned.get(key) === entry) owned.delete(key);
      const left = (inflight.get(claims.sbx) ?? 1) - 1;
      if (left > 0) inflight.set(claims.sbx, left);
      else inflight.delete(claims.sbx);
    }
  }

  /**
   * Where a sandbox caller's Abort goes, or the refusal: only an in-flight Exec of its own sandbox,
   * on the worker it named, under the worker's id.
   */
  function sandboxAbort(
    claims: SandboxTokenClaims,
    sandboxId: string,
    reqId: number,
  ): { wrk: string; wid: number } | { refusal: Error } {
    const entry = owned.get(ownKey(claims.sbx, reqId));
    if (!entry || entry.wrk !== sandboxId) {
      const why = 'abort not permitted: not an in-flight Exec of this sandbox';
      refused('abort', why, claims);
      return { refusal: grpcError(status.PERMISSION_DENIED, why) };
    }
    return entry;
  }

  return { exec: sandboxExec, abort: sandboxAbort };
}
