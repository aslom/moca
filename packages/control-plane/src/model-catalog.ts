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

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw unavailable(`it answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw unavailable('it answered with a body that is not JSON');
  }
}

/** LiteLLM's `/model/info` → entries, chat models only, one per name with the smallest limits. */
export function parseLiteLLMModelInfo(body: unknown): ModelEntry[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw unavailable('its /model/info has no data list');
  const byId = new Map<string, ModelEntry>();
  for (const raw of data) {
    const row = (raw ?? {}) as { model_name?: unknown; model_info?: Record<string, unknown> };
    const id = row.model_name;
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) continue;
    const info = row.model_info ?? {};
    if (info.mode !== undefined && info.mode !== null && info.mode !== 'chat') continue;
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
  return [...byId.values()];
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
): Promise<ModelEntry[]> {
  const base = target.baseUrl.replace(/\/+$/, '');
  const isAnthropic = URL.parse(base)?.hostname === ANTHROPIC_HOST;
  const headers: Record<string, string> =
    target.header === 'x-api-key'
      ? { 'x-api-key': target.secret }
      : { authorization: `Bearer ${target.secret}` };
  if (isAnthropic) headers['anthropic-version'] = '2023-06-01';
  try {
    if (!isAnthropic) {
      return parseLiteLLMModelInfo(
        await getJson(`${base}/model/info`, headers, fetchImpl, timeoutMs),
      );
    }
    const out: ModelEntry[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
      const url = new URL(`${base}/v1/models`);
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const body = (await getJson(url.toString(), headers, fetchImpl, timeoutMs)) as {
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
    return out;
  } catch (err) {
    if (err instanceof CpError) throw err;
    // A network failure or a timeout. The error's own text can carry the URL, never the secret,
    // but it is dropped anyway: the caller needs only "unavailable".
    throw unavailable('it did not answer');
  }
}

export type ModelChoice = { model: string; limits?: ModelLimits; verified: boolean };

/**
 * Check a model id against the credential's catalog (spec §4.2). Listed: its limits. Not listed:
 * `model_unavailable`. Catalog unreadable: accepted unverified, so a gateway outage never blocks a
 * new session; a wrong id then fails its first turn with the gateway's own error.
 */
export async function chooseModel(
  target: InferenceTarget,
  id: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelChoice> {
  let catalog: ModelEntry[];
  try {
    catalog = await fetchModelCatalog(target, fetchImpl);
  } catch (err) {
    if (err instanceof CpError && err.code === 'model_catalog_unavailable') {
      return { model: id, verified: false };
    }
    throw err;
  }
  const hit = catalog.find((m) => m.id === id);
  if (!hit) {
    throw new CpError(
      'model_unavailable',
      `credential '${credential}' does not offer model '${id}' (it offers ${catalog.length} models; list them with GET /v1/models)`,
    );
  }
  const { id: _id, ...limits } = hit;
  return {
    model: id,
    ...(sanitizeLimits(limits) ? { limits: sanitizeLimits(limits) } : {}),
    verified: true,
  };
}
