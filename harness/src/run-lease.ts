import { writeResult, toResultRecord, type RedisLike } from './leaf-result-store.js';

/**
 * In-flight markers for sync /runs leaves (#558). A sync run holds its entire lifecycle in the
 * worker process that received POST /v1/runs: nothing else knows it exists, so when the
 * supervisor pod dies (PID 1's exit SIGKILLs every worker before the IPC `disconnect` path can
 * run — see worker.ts), the `finally` that would have written `leaf:result:<sid>` never fires,
 * `/runs/status` answers `queued` forever, and the `run_started` audit never pairs. The sandbox
 * -pod-kill path reconciles precisely because its worker SURVIVES the failure it observes; the
 * run lease gives the supervisor-kill path the same property by making the run's existence
 * outlive the process that holds it.
 *
 * Two keys per run, on the same Redis as the result record it reconciles toward:
 *
 *   sh:run:<sid>      the marker — who holds the run and the RAW session id to correlate the
 *                     reaped record with. Lives as long as the run plus a safety TTL.
 *   sh:run:<sid>:hb   the heartbeat — a short-TTL key the holder refreshes on an interval. Its
 *                     absence is the only evidence of death the reaper trusts: a worker paused
 *                     past the stale window reads as dead exactly like a killed one.
 *
 * The reaper (reapOrphanedRuns) is armed by every worker and sweeps periodically: claims markers
 * whose heartbeat is gone and finalizes them as `{status:'failed', reason:'owner_lost'}` — the
 * same terminal shape the sandbox-kill path produces, so `mocactl get` reads a legible failure
 * instead of `queued` (or a bare 404) forever.
 */

/** The run's marker: who holds it, and the raw id a reaped result record must correlate with. */
export function runMarkerKey(sid: string): string {
  return `sh:run:${sid}`;
}

/** The run's heartbeat: present while the holder lives, expired shortly after it stops. */
export function runHeartbeatKey(sid: string): string {
  return `sh:run:${sid}:hb`;
}

export interface RunLeaseTimings {
  /** How often the holder refreshes its heartbeat key. */
  heartbeatMs: number;
  /**
   * The heartbeat key's TTL: how long a silent holder still reads as alive. Generous on purpose
   * (6x the heartbeat interval) — a false-positive reap writes a failure a live run then has to
   * overwrite, while a late reap only delays the reconciliation by the same margin.
   */
  staleMs: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const raw = env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export function runLeaseTimings(env: NodeJS.ProcessEnv = process.env): RunLeaseTimings {
  return {
    heartbeatMs: positiveInt(env, 'SH_RUN_HEARTBEAT_MS', 10_000),
    staleMs: positiveInt(env, 'SH_RUN_STALE_MS', 60_000),
  };
}

/**
 * The structural Redis surface the lease needs. `RedisResultStore` satisfies it (its `keys` SCANs
 * rather than KEYS — the O(N) blocking command has no place on the data-plane Redis), and tests
 * inject an in-memory fake the same way they fake `RedisLike`.
 */
export interface RunLeaseStore extends RedisLike {
  del(key: string): Promise<unknown>;
  /** Atomic claim: return the value and remove the key in one step. */
  getdel(key: string): Promise<string | null>;
  /** Every key matching a glob pattern. Implemented with SCAN by the real store. */
  keys(pattern: string): Promise<string[]>;
}

/** What the marker records — `rawSessionId` is the un-sanitized envelope id (`toResultRecord`
 * wants it for caller correlation; the reaper has only the sanitized key to key off). */
export interface RunMarker {
  owner: string;
  rawSessionId: string;
  startedAt: number;
}

export interface RunLease {
  /** Settles once the marker and first heartbeat are recorded (or the failure is rolled back). */
  readonly ready: Promise<void>;
  /** Stop the heartbeat and clear both keys. Never rejects: a release error must not fail the run. */
  release(): Promise<void>;
}

/**
 * Await `fn`, swallowing whatever it throws — including a synchronous "not a function" from a
 * store seam that predates `del` (the route tests' fakes) — so a lease can never fail the run it
 * describes. Best-effort is the contract everywhere the lease cleans up after itself.
 */
const quietly = async (fn: () => unknown): Promise<void> => {
  try {
    await fn();
  } catch {
    /* best-effort by contract */
  }
};

/**
 * Record a run as in-flight and arm its heartbeat. FAILS OPEN: a Redis that cannot take the
 * marker gets a warning and a no-op lease, not a failed run — the same call will likely fail
 * `writeResult` later anyway, and refusing to run at all would trade a reconciliation gap for an
 * outage. The rolled-back case deletes whatever half of the marker landed so a partial write
 * cannot read as an orphan.
 */
export function beginRunLease(
  store: RunLeaseStore,
  sid: string,
  opts: {
    owner: string;
    rawSessionId: string;
    /** Safety TTL on the marker, so an unreaped one cannot outlive its result record. */
    ttlSeconds: number;
    timings?: RunLeaseTimings;
  },
): RunLease {
  const timings = opts.timings ?? runLeaseTimings();
  const markerKey = runMarkerKey(sid);
  const hbKey = runHeartbeatKey(sid);
  const hbTtlS = Math.max(1, Math.ceil(timings.staleMs / 1000));
  const beat = () => store.set(hbKey, '1', { EX: hbTtlS });
  const marker: RunMarker = {
    owner: opts.owner,
    rawSessionId: opts.rawSessionId,
    startedAt: Date.now(),
  };
  let released = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const ready = store
    .set(markerKey, JSON.stringify(marker), { EX: opts.ttlSeconds })
    .then(() => beat())
    .then(async () => {
      // The run finished before the lease even landed (a fast-failing envelope can): arming the
      // heartbeat now would resurrect keys release() is about to delete. Clean up instead.
      if (released) {
        await quietly(() => store.del(markerKey));
        await quietly(() => store.del(hbKey));
        return;
      }
      timer = setInterval(() => void beat().catch(() => {}), timings.heartbeatMs);
      timer.unref(); // a lease must never be the reason a worker refuses to exit
    })
    .catch((err: unknown) => {
      console.warn(
        `[run-lease] could not record in-flight run ${sid}: ${
          err instanceof Error ? err.message : String(err)
        }; running unreconciled`,
      );
      // Roll back whatever half landed: a marker without a heartbeat is exactly the shape the
      // reaper reads as dead, and this run is alive.
      return quietly(() => store.del(markerKey)).then(() => quietly(() => store.del(hbKey)));
    });

  return {
    ready,
    async release(): Promise<void> {
      released = true;
      if (timer) clearInterval(timer);
      // Before the DELs: awaiting the begin chain keeps node-redis's per-client command order
      // (marker SET, heartbeat SET, then these DELs) from resurrecting a key release removed.
      await ready;
      await quietly(() => store.del(markerKey));
      await quietly(() => store.del(hbKey));
    },
  };
}

/** One reaped run, as reported to the caller for audit and logging. */
export interface ReapedRun {
  /** The sanitized leaf session id — the key the result record is written under. */
  sid: string;
  /** The raw envelope session id from the marker, for caller correlation. */
  rawSessionId: string;
  /** The holder that died (`hostname:pid`), from the marker. */
  owner: string;
}

/**
 * Sweep every run marker and finalize the ones whose heartbeat is gone. Claiming is a `getdel`,
 * so the N workers that each arm a reaper cannot double-finalize one run; and a holder that
 * revives between the stale read and the claim (its next heartbeat landed mid-sweep) gets its
 * marker restored rather than a failure it would have to overwrite. A write that fails mid-reap
 * also restores the marker, so the next sweep retries the run instead of losing it.
 */
export async function reapOrphanedRuns(
  store: RunLeaseStore,
  opts: { ttlSeconds: number; onReap?: (run: ReapedRun) => void },
): Promise<ReapedRun[]> {
  const reaped: ReapedRun[] = [];
  const all = await store.keys('sh:run:*');
  for (const key of all) {
    if (key.endsWith(':hb')) continue; // heartbeats are only read through their marker
    const sid = key.slice('sh:run:'.length);
    if (!sid) continue;
    if ((await store.get(runHeartbeatKey(sid))) !== null) continue; // holder alive
    const raw = await store.getdel(runMarkerKey(sid));
    if (raw === null) continue; // another reaper claimed it, or the holder released
    if ((await store.get(runHeartbeatKey(sid))) !== null) {
      // Alive after all: the stale read raced the holder's next heartbeat.
      await store.set(runMarkerKey(sid), raw, { EX: opts.ttlSeconds }).catch(() => {});
      continue;
    }
    let marker: Partial<RunMarker> = {};
    try {
      marker = JSON.parse(raw) as Partial<RunMarker>;
    } catch {
      // Unreadable marker: reap anyway. The sanitized sid still keys the record the client
      // polls; only the raw-id correlation degrades.
    }
    const run: ReapedRun = {
      sid,
      rawSessionId: typeof marker.rawSessionId === 'string' ? marker.rawSessionId : sid,
      owner: typeof marker.owner === 'string' ? marker.owner : 'unknown',
    };
    try {
      await writeResult(
        store,
        sid,
        toResultRecord(
          { status: 'failed', reason: 'owner_lost' },
          run.rawSessionId,
          new Date().toISOString(),
        ),
        opts.ttlSeconds,
      );
    } catch (err) {
      console.warn(
        `[run-lease] could not finalize orphaned run ${sid}: ${
          err instanceof Error ? err.message : String(err)
        }; restoring the marker for the next sweep`,
      );
      await store.set(runMarkerKey(sid), raw, { EX: opts.ttlSeconds }).catch(() => {});
      continue;
    }
    await store.del(runHeartbeatKey(sid)).catch(() => {});
    opts.onReap?.(run);
    reaped.push(run);
  }
  return reaped;
}
