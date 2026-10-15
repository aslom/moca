import type { InferenceAuthHeader } from './credential-store.js';
import { CpError } from './errors.js';
import { MODEL_ID_RE, sanitizeLimits, type ModelEntry, type ModelLimits } from './models.js';

/**
 * The model catalog (per-session model spec §4.1): which models a credential reaches, asked of the
 * endpoint the credential is already bound to -- the secret goes nowhere it does not already go.
 * `api.anthropic.com` answers `GET /v1/models` (ids only: the harness takes limits from pi's
 * registry, spec §5.2); any other endpoint is treated as LiteLLM and answers `GET /model/info`.
 */
export interface InferenceTarget {
  baseUrl: string;
  secret: string;
  header: InferenceAuthHeader;
}

export const CATALOG_TIMEOUT_MS = 5000;
const ANTHROPIC_HOST = 'api.anthropic.com';
/** Pages of 1000: Anthropic has a few dozen models, so this bounds a misbehaving `has_more`. */
const MAX_ANTHROPIC_PAGES = 20;

const unavailable = (why: string) =>
  new CpError('model_catalog_unavailable', `the inference endpoint could not list models: ${why}`);

/** A catalog body larger than this is refused unread (final review F9): no model list is near it. */
export const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  // redirect: 'error' prevents cross-origin redirects from forwarding the x-api-key header
  // (Fetch spec strips only Authorization on cross-origin redirects, not custom headers).
  const res = await fetchImpl(url, { headers, signal, redirect: 'error' });
  if (!res.ok) {
    // The status stays server-side: echoed to the caller it would make this route a reachability
    // oracle into the control plane's network (final review F2). The log names the host only --
    // never the path or query, which may carry tenant detail, and never the secret.
    const host = URL.parse(url)?.hostname ?? 'an unparseable URL';
    console.error(`[control-plane] model catalog: ${host} answered ${res.status}`);
    throw unavailable('it refused the request');
  }
  const text = await readCapped(res, MAX_CATALOG_BODY_BYTES);
  if (text === undefined) throw unavailable('it answered with a body that is too large');
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable('it answered with a body that is not JSON');
  }
}

/** The body as text, or undefined once it passes `cap` bytes -- read no further than that. */
async function readCapped(res: Response, cap: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * What a credential reaches: the listed models, and the wildcard routes (LiteLLM `model_name`s with
 * a `*`, e.g. `anthropic/*`) that are not models but accept any id they match (final review F8).
 * Only `models` is shown to a caller (GET /v1/models); `patterns` only widens chooseModel.
 */
export interface ModelCatalog {
  models: ModelEntry[];
  patterns: string[];
}

/**
 * LiteLLM's `/model/info` → entries, chat models only, one per name with the smallest limits.
 * Wildcard routes go to `patterns`, not the list: listed literally they are an id no request can
 * use, and a concrete id they route would fail as unlisted.
 */
export function parseLiteLLMModelInfo(body: unknown): ModelCatalog {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw unavailable('its /model/info has no data list');
  const byId = new Map<string, ModelEntry>();
  const patterns = new Set<string>();
  for (const raw of data) {
    const row = (raw ?? {}) as { model_name?: unknown; model_info?: Record<string, unknown> };
    const id = row.model_name;
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) continue;
    const info = row.model_info ?? {};
    if (info.mode !== undefined && info.mode !== null && info.mode !== 'chat') continue;
    if (id.includes('*')) {
      patterns.add(id);
      continue;
    }
    const limits =
      sanitizeLimits({
        contextWindow: info.max_input_tokens,
        maxTokens: info.max_output_tokens,
        reasoning: info.supports_reasoning,
        vision: info.supports_vision,
      }) ?? {};
    const prev = byId.get(id);
    byId.set(id, prev ? { id, ...smaller(prev, limits) } : { id, ...limits });
  }
  return { models: [...byId.values()], patterns: [...patterns] };
}

/** `*` is any run of characters (none included); the rest literal; the whole id must match. */
function matchesPattern(id: string, pattern: string): boolean {
  const re = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`).test(id);
}

/** Two deployments behind one name: the request must fit both, so take the smaller of each. */
function smaller(a: ModelLimits, b: ModelLimits): ModelLimits {
  const min = (x?: number, y?: number) =>
    x === undefined ? y : y === undefined ? x : Math.min(x, y);
  const and = (x?: boolean, y?: boolean) => (x === undefined ? y : y === undefined ? x : x && y);
  return (
    sanitizeLimits({
      contextWindow: min(a.contextWindow, b.contextWindow),
      maxTokens: min(a.maxTokens, b.maxTokens),
      reasoning: and(a.reasoning, b.reasoning),
      vision: and(a.vision, b.vision),
    }) ?? {}
  );
}

export async function fetchModelCatalog(
  target: InferenceTarget,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CATALOG_TIMEOUT_MS,
): Promise<ModelCatalog> {
  const base = target.baseUrl.replace(/\/+$/, '');
  const isAnthropic = URL.parse(base)?.hostname === ANTHROPIC_HOST;
  const headers: Record<string, string> =
    target.header === 'x-api-key'
      ? { 'x-api-key': target.secret }
      : { authorization: `Bearer ${target.secret}` };
  if (isAnthropic) headers['anthropic-version'] = '2023-06-01';
  // Create one timeout signal that bounds the entire catalog call (all pages if paging).
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    if (!isAnthropic) {
      return parseLiteLLMModelInfo(await getJson(`${base}/model/info`, headers, fetchImpl, signal));
    }
    // Anthropic has no wildcard routes.
    const out: ModelEntry[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
      const url = new URL(`${base}/v1/models`);
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const body = (await getJson(url.toString(), headers, fetchImpl, signal)) as {
        data?: unknown;
        has_more?: unknown;
        last_id?: unknown;
      };
      if (!Array.isArray(body?.data)) throw unavailable('its /v1/models has no data list');
      for (const m of body.data as Array<{ id?: unknown }>) {
        if (typeof m?.id === 'string' && MODEL_ID_RE.test(m.id)) out.push({ id: m.id });
      }
      if (body.has_more !== true || typeof body.last_id !== 'string') break;
      after = body.last_id;
    }
    return { models: out, patterns: [] };
  } catch (err) {
    if (err instanceof CpError) throw err;
    // A network failure or a timeout. The error's own text can carry the URL, never the secret,
    // but it is dropped anyway: the caller needs only "unavailable".
    throw unavailable('it did not answer');
  }
}

export type ModelChoice = { model: string; limits?: ModelLimits; verified: boolean };

/**
 * Check a model id against the credential's catalog (spec §4.2). Listed: its limits. Not listed but
 * matched by a wildcard route: accepted verified, with no limits (the route names none). Neither:
 * `model_unavailable`. Catalog unreadable: accepted unverified, so a gateway outage never blocks a
 * new session; a wrong id then fails its first turn with the gateway's own error.
 */
export async function chooseModel(
  target: InferenceTarget,
  id: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelChoice> {
  let catalog: ModelCatalog;
  try {
    catalog = await fetchModelCatalog(target, fetchImpl);
  } catch (err) {
    if (err instanceof CpError && err.code === 'model_catalog_unavailable') {
      return { model: id, verified: false };
    }
    throw err;
  }
  const hit = catalog.models.find((m) => m.id === id);
  if (!hit) {
    // An id that itself holds a `*` is a route, not a model: it never matches one (F8).
    if (!id.includes('*') && catalog.patterns.some((p) => matchesPattern(id, p))) {
      return { model: id, verified: true };
    }
    throw new CpError(
      'model_unavailable',
      `credential '${credential}' does not offer model '${id}' (it offers ${catalog.models.length} models; list them with GET /v1/models)`,
    );
  }
  const { id: _id, ...limits } = hit;
  return {
    model: id,
    ...(sanitizeLimits(limits) ? { limits: sanitizeLimits(limits) } : {}),
    verified: true,
  };
}
