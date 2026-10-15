import { describe, expect, it, vi } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { exchangeCredential } from '../src/exchange.js';
import { makeDeps, ctx, alice, codeOf, seedCredential, type TestDeps } from './helpers/deps.js';

const INFO = {
  data: [
    {
      model_name: 'claude-opus-4-8',
      model_info: { mode: 'chat', max_input_tokens: 200000, max_output_tokens: 32000 },
    },
    { model_name: 'meta-llama/Llama-3.1-8B-Instruct', model_info: { max_input_tokens: 131072 } },
  ],
};

/** A fetch that serves INFO at /model/info, or fails every call when `down`. */
function gateway(down = false): typeof fetch {
  return (async (url: string) => {
    if (down) return new Response('', { status: 502 });
    if (url.endsWith('/model/info')) return new Response(JSON.stringify(INFO), { status: 200 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

async function deps(down = false): Promise<TestDeps> {
  const d = makeDeps({ fetchImpl: gateway(down) });
  await seedCredential(d);
  return d;
}

const create = (d: TestDeps, body: Record<string, unknown>) =>
  HANDLERS.createSession!(ctx({ principal: alice, body }), d);
const patch = (d: TestDeps, body: unknown) =>
  HANDLERS.updateSession!(ctx({ principal: alice, params: { id: 'sid-fixed' }, body }), d);

describe('POST /v1/sessions with a model', () => {
  it('records a listed model with its limits and says it was verified', async () => {
    const d = await deps();
    const res = await create(d, { model: 'claude-opus-4-8' });
    expect(res.body).toMatchObject({ model: 'claude-opus-4-8', modelVerified: true });
    expect(await d.index.get('sid-fixed')).toMatchObject({
      model: 'claude-opus-4-8',
      modelLimits: { contextWindow: 200000, maxTokens: 32000 },
    });
  });

  it('accepts a model id with a slash', async () => {
    const d = await deps();
    await create(d, { model: 'meta-llama/Llama-3.1-8B-Instruct' });
    expect((await d.index.get('sid-fixed'))?.model).toBe('meta-llama/Llama-3.1-8B-Instruct');
  });

  it('refuses a model the endpoint does not list', async () => {
    const d = await deps();
    expect(await codeOf(() => create(d, { model: 'gpt-x' }))).toBe('model_unavailable');
  });

  it('accepts an unverified model when the catalog is down', async () => {
    const d = await deps(true);
    const res = await create(d, { model: 'gpt-x' });
    expect(res.body).toMatchObject({ model: 'gpt-x', modelVerified: false });
    const rec = await d.index.get('sid-fixed');
    expect(rec?.model).toBe('gpt-x');
    expect(rec?.modelLimits).toBeUndefined();
  });

  it.each([[42], ['has space'], ['']])('refuses a malformed model %j', async (model) => {
    const d = await deps();
    expect(await codeOf(() => create(d, { model }))).toBe('invalid_request');
  });

  it('records nothing and adds nothing to the response without a model', async () => {
    const d = await deps();
    const res = await create(d, {});
    expect(res.body).not.toHaveProperty('model');
    expect((await d.index.get('sid-fixed'))?.model).toBeUndefined();
  });

  it('shows the model in the session view', async () => {
    const d = await deps();
    await create(d, { model: 'claude-opus-4-8' });
    const view = await HANDLERS.getSession!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    expect(view.body).toMatchObject({ model: 'claude-opus-4-8' });
  });
});

describe('PATCH /v1/sessions/{id}', () => {
  it('switches a session created before this change, then back to the default', async () => {
    const d = await deps();
    await create(d, {});
    const token = (
      (await HANDLERS.mintSessionToken!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d))
        .body as { token: string }
    ).token;

    const res = await patch(d, { model: 'claude-opus-4-8' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'claude-opus-4-8', modelVerified: true });
    expect((await exchangeCredential(token, d)).model).toMatchObject({ id: 'claude-opus-4-8' });

    const reset = await patch(d, { model: null });
    expect(reset.body).toMatchObject({ model: null });
    expect(await exchangeCredential(token, d)).not.toHaveProperty('model');
  });

  it('audits the switch with the old and new model', async () => {
    const d = await deps();
    await create(d, { model: 'claude-opus-4-8' });
    await patch(d, { model: 'meta-llama/Llama-3.1-8B-Instruct' });
    const audit = d.streams.get('sh:cp:audit') ?? [];
    expect(audit.at(-1)).toMatchObject({
      decision: 'model_changed',
      model: 'meta-llama/Llama-3.1-8B-Instruct',
      fromModel: 'claude-opus-4-8',
    });
  });

  it.each([
    [{}, 'invalid_request'],
    [{ model: 'claude-opus-4-8', title: 'x' }, 'invalid_request'],
    [{ model: 7 }, 'invalid_request'],
    [{ model: 'gpt-x' }, 'model_unavailable'],
  ])('refuses %j with %s', async (body, code) => {
    const d = await deps();
    await create(d, {});
    expect(await codeOf(() => patch(d, body))).toBe(code);
  });

  it('refuses a tombstoned session', async () => {
    const d = await deps();
    await create(d, {});
    await d.index.tombstone('sid-fixed');
    expect(await codeOf(() => patch(d, { model: 'claude-opus-4-8' }))).toBe('session_not_found');
  });
});

describe('the catalog routes', () => {
  const list = (d: TestDeps, credential?: string) =>
    HANDLERS.listModels!(
      ctx({
        principal: alice,
        query: new URLSearchParams(credential ? { credential } : {}),
      }),
      d,
    );

  it('lists the models of a named credential', async () => {
    const d = await deps();
    const res = await list(d, 'my-anthropic');
    expect(res.body).toEqual({
      credential: 'my-anthropic',
      models: [
        { id: 'claude-opus-4-8', contextWindow: 200000, maxTokens: 32000 },
        { id: 'meta-llama/Llama-3.1-8B-Instruct', contextWindow: 131072 },
      ],
    });
  });

  it('lists for the only inference credential when none is named', async () => {
    const d = await deps();
    expect((await list(d)).body).toMatchObject({ credential: 'my-anthropic' });
  });

  it('lists for the operator fallback for a subject with no credential', async () => {
    const d = makeDeps({
      fetchImpl: gateway(),
      config: {
        allowOperatorFallback: true,
        operatorInferenceToken: 'op-tok', // notsecret
        defaultInferenceEndpoint: 'https://litellm.internal',
      },
    });
    expect((await list(d)).body).toMatchObject({ credential: 'operator-fallback' });
  });

  it('refuses a subject with no credential and no fallback', async () => {
    const d = makeDeps({ fetchImpl: gateway() });
    expect(await codeOf(() => list(d))).toBe('credential_required');
  });

  it('503s when the catalog is down', async () => {
    const d = await deps(true);
    expect(await codeOf(() => list(d, 'my-anthropic'))).toBe('model_catalog_unavailable');
  });

  it("lists a session's models from the credential it runs on", async () => {
    const d = await deps();
    await create(d, {});
    const res = await HANDLERS.listSessionModels!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    expect(res.body).toMatchObject({ credential: 'my-anthropic' });
    const body = res.body as { models: { id: string }[] };
    expect(body.models.map((m) => m.id)).toEqual([
      'claude-opus-4-8',
      'meta-llama/Llama-3.1-8B-Instruct',
    ]);
  });

  it('refuses a tombstoned session', async () => {
    const d = await deps();
    await create(d, {});
    await d.index.tombstone('sid-fixed');
    expect(
      await codeOf(() =>
        HANDLERS.listSessionModels!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d),
      ),
    ).toBe('session_not_found');
  });
});

describe('a misdirected secret never reaches the catalog (final review F1)', () => {
  // The catalog always sends the real secret, so the exchange's direct-mode check applies to it
  // whatever the mode: a raw Anthropic key must not go to a gateway, a Bearer token not to Anthropic.
  const RAW_KEY = 'sk-ant-api03-not-a-real-key'; // notsecret
  const spy = () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(INFO), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, f };
  };

  const cases = [
    {
      name: 'a raw Anthropic key resolving to a gateway default',
      endpoint: 'https://litellm.internal',
      over: {
        kind: 'api-key',
        destination: { hosts: ['api.anthropic.com'] },
        endpoint: undefined,
        secret: { key: RAW_KEY },
      },
      text: 'set its endpoint to https://api.anthropic.com',
      secret: RAW_KEY,
    },
    {
      name: 'a Bearer token resolving to api.anthropic.com',
      endpoint: 'https://api.anthropic.com',
      over: { endpoint: undefined, destination: { hosts: ['api.anthropic.com'] } },
      text: "store the key with kind 'api-key'",
      secret: 'sk-fake',
    },
  ];

  const routes = {
    'POST with a model': (d: TestDeps) => create(d, { model: 'claude-opus-4-8' }),
    PATCH: async (d: TestDeps) => {
      await create(d, {});
      return patch(d, { model: 'claude-opus-4-8' });
    },
    'GET /v1/models': (d: TestDeps) =>
      HANDLERS.listModels!(ctx({ principal: alice, query: new URLSearchParams() }), d),
    'GET /v1/sessions/{id}/models': async (d: TestDeps) => {
      await create(d, {});
      return HANDLERS.listSessionModels!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d);
    },
  };

  for (const c of cases) {
    for (const [route, call] of Object.entries(routes)) {
      it(`${route}: refuses ${c.name} without fetching`, async () => {
        const { calls, f } = spy();
        const d = makeDeps({ fetchImpl: f, config: { defaultInferenceEndpoint: c.endpoint } });
        await seedCredential(d, 'github:1234', 'my-anthropic', c.over);
        let err: { code?: string; message?: string } = {};
        try {
          await call(d);
        } catch (e) {
          err = e as typeof err;
        }
        expect(err.code).toBe('credential_required');
        expect(err.message).toContain(c.text);
        expect(err.message).not.toContain(c.secret);
        expect(calls).toEqual([]);
      });
    }
  }

  it.each([
    [RAW_KEY, 'https://litellm.internal'],
    ['op-gw-token', 'https://api.anthropic.com'], // notsecret
  ])(
    'GET /v1/models: a misconfigured operator fallback is credential_unavailable',
    async (token, endpoint) => {
      const { calls, f } = spy();
      const d = makeDeps({
        fetchImpl: f,
        config: {
          allowOperatorFallback: true,
          operatorInferenceToken: token,
          defaultInferenceEndpoint: endpoint,
        },
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await codeOf(() => routes['GET /v1/models'](d))).toBe('credential_unavailable');
        expect(log.mock.calls.join('\n')).not.toContain(token);
      } finally {
        log.mockRestore();
      }
      expect(calls).toEqual([]);
    },
  );
});
