import { CpError } from './errors.js';
import { hostMatches, parseDestination } from './egress-destination.js';
import { resolverFor } from './egress-resolver.js';
import { asRecord, auditBestEffort, seconds } from './handler-util.js';
import type { Handler } from './handlers.js';
import { isEnrolled } from './sandbox-config.js';
import { SANDBOX_ID_RE } from './sandbox-handlers.js';
import { viewOf } from './sandbox-store.js';

/**
 * `POST /v1/egress/credential` (SBX0.2b spec §4.2): the owner lookup moca-egress calls. Only TYPES
 * come from handlers.ts, which spreads this table into HANDLERS. No header value ever reaches the
 * audit or a log line.
 */

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const MIN_TTL_S = 5;

interface Element {
  name: string;
  port: number;
  pathPrefix: string;
  descriptor: Parameters<ReturnType<typeof resolverFor>>[1];
}

export const EGRESS_HANDLERS: Record<string, Handler> = {
  lookupEgressCredential: async (ctx, deps) => {
    // 1. Caller: the router resolved the host from its token; without one this is a routing bug.
    const host = ctx.egressHost;
    if (!host) throw new CpError('unauthorized', 'egress authentication failed');
    const cfg = deps.config.sandbox;
    if (!cfg?.egress || !deps.sandboxes) {
      throw new CpError('internal_error', 'the sandbox service is not configured');
    }
    const b = asRecord(ctx.body);
    if (typeof b.sandbox !== 'string' || !SANDBOX_ID_RE.test(b.sandbox)) {
      throw new CpError('invalid_request', 'sandbox must be a sandbox id');
    }
    if (typeof b.host !== 'string' || !HOST_RE.test(b.host)) {
      throw new CpError('invalid_request', 'host must be a hostname');
    }
    const sandboxId = b.sandbox;
    const requested = b.host;
    const now = seconds(deps);

    // 2. Sandbox: live and on this host; one code for unknown, terminated and another host's.
    const rec = await deps.sandboxes.get(sandboxId, now);
    if (!rec || viewOf(rec, now).state !== 'ready' || !host.workers.includes(rec.worker)) {
      throw new CpError('sandbox_not_found', 'no such sandbox');
    }
    const owner = rec.owner;
    const none = async (): Promise<never> => {
      await auditBestEffort(deps, 'lookupEgressCredential', sandboxId, {
        subject: owner,
        sandboxId,
        decision: 'egress_credential_none',
        destination: requested,
        egressHost: host.id,
      });
      throw new CpError('no_credential', 'no credential for this destination');
    };
    if (!isEnrolled(owner, deps.identity.rolesFor(owner), deps.config)) return none();

    // 3. Credentials: one element per (credential, matching destination entry).
    const elements: Element[] = [];
    for (const d of await deps.credentials.list(owner)) {
      if (d.consumer !== 'sandbox-egress') continue;
      for (const entry of d.destination.hosts) {
        let dest;
        try {
          dest = parseDestination(entry);
        } catch {
          continue; // an unparseable stored entry never matches; it must not fail the lookup
        }
        if (!hostMatches(dest.host, requested)) continue;
        elements.push({
          name: d.name,
          port: dest.port,
          pathPrefix: dest.pathPrefix,
          descriptor: d,
        });
      }
    }
    if (elements.length === 0) return none();
    elements.sort(
      (x, y) =>
        x.port - y.port ||
        y.pathPrefix.length - x.pathPrefix.length ||
        (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
    );
    for (let i = 1; i < elements.length; i++) {
      if (
        elements[i]!.port === elements[i - 1]!.port &&
        elements[i]!.pathPrefix === elements[i - 1]!.pathPrefix
      ) {
        throw new CpError('destination_ambiguous', 'two credentials hold the same destination');
      }
    }

    // 4. Resolve and render (the seam).
    let earliest: number | null = null;
    const credentials = [];
    for (const e of elements) {
      const r = await resolverFor(e.descriptor)(owner, e.descriptor, deps);
      if (r.expiresAt !== null && (earliest === null || r.expiresAt < earliest)) {
        earliest = r.expiresAt;
      }
      credentials.push({
        name: e.name,
        port: e.port,
        pathPrefix: e.pathPrefix,
        headers: r.headers,
        expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt * 1000).toISOString(),
      });
    }
    const ttlSeconds = Math.max(
      MIN_TTL_S,
      earliest === null
        ? cfg.egress.ttlSeconds
        : Math.min(cfg.egress.ttlSeconds, Math.floor(earliest - now)),
    );

    // 5. Audit names only.
    await auditBestEffort(deps, 'lookupEgressCredential', sandboxId, {
      subject: owner,
      sandboxId,
      decision: 'egress_credential_issued',
      credential: elements.map((e) => e.name).join(','),
      destination: requested,
      egressHost: host.id,
    });
    return { status: 200, body: { subject: owner, ttlSeconds, credentials } };
  },
};
