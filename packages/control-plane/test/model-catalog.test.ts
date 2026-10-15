import { describe, expect, it } from 'vitest';
import {
  chooseModel,
  fetchModelCatalog,
  parseLiteLLMModelInfo,
  type InferenceTarget,
} from '../src/model-catalog.js';
import { codeOf } from './helpers/deps.js';

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(...replies: Array<(url: string) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next(url);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const litellm: InferenceTarget = {
  baseUrl: 'https://litellm.internal',
  secret: 'sk-litellm', // notsecret
  header: 'authorization',
};
const anthropic: InferenceTarget = {
  baseUrl: 'https://api.anthropic.com',
  secret: 'sk-ant-api-x', // notsecret
  header: 'x-api-key',
};

const INFO = {
  data: [
    {
      model_name: 'claude-opus-4-8',
      model_info: {
        mode: 'chat',
        max_input_tokens: 200000,
        max_output_tokens: 32000,
        supports_reasoning: true,
        supports_vision: true,
      },
    },
    // A second deployment of the same load-balanced model, with smaller limits: the smaller wins.
    {
      model_name: 'claude-opus-4-8',
      model_info: { mode: 'chat', max_input_tokens: 150000, max_output_tokens: 32000 },
    },
    { model_name: 'text-embedding-3', model_info: { mode: 'embedding' } },
    { model_name: 'granite-4.1-8b', model_info: {} },
    { model_name: 'has space', model_info: {} },
  ],
};

describe('parseLiteLLMModelInfo', () => {
  it('maps, filters non-chat and invalid names, and dedupes keeping the smaller limits', () => {
    expect(parseLiteLLMModelInfo(INFO)).toEqual([
      {
        id: 'claude-opus-4-8',
        contextWindow: 150000,
        maxTokens: 32000,
        reasoning: true,
        vision: true,
      },
      { id: 'granite-4.1-8b' },
    ]);
  });

  it('refuses a body with no data array', async () => {
    expect(await codeOf(() => parseLiteLLMModelInfo({ models: [] }))).toBe(
      'model_catalog_unavailable',
    );
  });
});

describe('fetchModelCatalog — LiteLLM', () => {
  it('calls /model/info with the credential as Bearer', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    const models = await fetchModelCatalog(litellm, f);
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'granite-4.1-8b']);
    expect(calls[0]!.url).toBe('https://litellm.internal/model/info');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-litellm');
  });

  it.each([
    ['https://litellm.internal/v1', 'https://litellm.internal/v1/model/info'],
    ['https://litellm.internal/', 'https://litellm.internal/model/info'],
    ['https://litellm.internal/v1/', 'https://litellm.internal/v1/model/info'],
  ])('joins %s without a doubled slash', async (baseUrl, expected) => {
    const { f, calls } = fakeFetch(json(INFO));
    await fetchModelCatalog({ ...litellm, baseUrl }, f);
    expect(calls[0]!.url).toBe(expected);
  });

  it('sends x-api-key when the binding says so', async () => {
    const { f, calls } = fakeFetch(json(INFO));
    await fetchModelCatalog({ ...litellm, header: 'x-api-key' }, f);
    expect(calls[0]!.headers['x-api-key']).toBe('sk-litellm');
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it.each([
    ['a non-2xx', () => new Response('nope', { status: 404 })],
    ['a 200 HTML page', () => new Response('<html>login</html>', { status: 200 })],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('maps %s to model_catalog_unavailable without the secret in the message', async (_n, r) => {
    const { f } = fakeFetch(r);
    let message = '';
    const code = await codeOf(async () => {
      try {
        await fetchModelCatalog(litellm, f);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    });
    expect(code).toBe('model_catalog_unavailable');
    expect(message).not.toContain('sk-litellm');
  });

  it('times out a gateway that never answers', async () => {
    const hang = (async (_u: string, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    expect(await codeOf(() => fetchModelCatalog(litellm, hang, 20))).toBe(
      'model_catalog_unavailable',
    );
  });
});

describe('fetchModelCatalog — Anthropic', () => {
  it('pages /v1/models with x-api-key and returns ids only', async () => {
    const { f, calls } = fakeFetch(
      json({ data: [{ id: 'claude-opus-4-8' }], has_more: true, last_id: 'claude-opus-4-8' }),
      json({ data: [{ id: 'claude-haiku-4-5' }], has_more: false, last_id: 'claude-haiku-4-5' }),
    );
    expect(await fetchModelCatalog(anthropic, f)).toEqual([
      { id: 'claude-opus-4-8' },
      { id: 'claude-haiku-4-5' },
    ]);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[1]!.url).toBe(
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-4-8',
    );
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-api-x');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('chooseModel', () => {
  it('returns the listed model with its limits, verified', async () => {
    const { f } = fakeFetch(json(INFO));
    expect(await chooseModel(litellm, 'granite-4.1-8b', 'litellm-prod', f)).toEqual({
      model: 'granite-4.1-8b',
      verified: true,
    });
  });

  it('refuses an id the endpoint does not list, naming the credential and the id', async () => {
    const { f } = fakeFetch(json(INFO));
    let message = '';
    const code = await codeOf(async () => {
      try {
        await chooseModel(litellm, 'gpt-x', 'litellm-prod', f);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    });
    expect(code).toBe('model_unavailable');
    expect(message).toContain('gpt-x');
    expect(message).toContain('litellm-prod');
  });

  it('accepts the id unverified when the catalog cannot be read', async () => {
    const { f } = fakeFetch(() => new Response('', { status: 502 }));
    expect(await chooseModel(litellm, 'gpt-x', 'litellm-prod', f)).toEqual({
      model: 'gpt-x',
      verified: false,
    });
  });
});
