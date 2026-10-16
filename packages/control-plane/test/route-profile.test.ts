import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES, matchRoute } from '../src/routes.js';
import { buildHandler } from '../src/server.js';
import { makeDeps } from './helpers/deps.js';

// SBX0 §4.1: the sandbox control plane mounts the login routes and its own, NOTHING else -- by an
// allow list per profile, so a route added later is unmounted under `sandbox` until someone lists it.
const SHARED = [
  'GET /healthz',
  'GET /readyz',
  'GET /v1/discovery',
  'POST /v1/auth/device',
  'POST /v1/auth/device/token',
  'POST /v1/auth/token',
  'POST /v1/auth/revoke',
  'POST /v1/auth/revoke-all',
  'GET /v1/me',
];

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(profile: 'harness' | 'sandbox') {
  const server = createServer(buildHandler(makeDeps({ config: { routeProfile: profile } })));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const concrete = (path: string) => path.replace(/\{[^}]+\}/g, 'x');

describe('route profiles (SBX0 §4.1)', () => {
  it('declares a non-empty profile list on every route', () => {
    expect(ROUTES.filter((r) => !r.profiles || r.profiles.length === 0).map((r) => r.path)).toEqual(
      [],
    );
  });

  it('shares exactly the probe, discovery and login routes between the two profiles', () => {
    const both = ROUTES.filter(
      (r) => r.profiles.includes('harness') && r.profiles.includes('sandbox'),
    );
    expect(both.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...SHARED].sort());
  });

  it('matches a route only under a profile that lists it', () => {
    expect(matchRoute('POST', '/v1/sessions', 'harness')?.route.operationId).toBe('createSession');
    expect(matchRoute('POST', '/v1/sessions', 'sandbox')).toBeNull();
    expect(matchRoute('GET', '/v1/me', 'sandbox')?.route.operationId).toBe('getMe');
    expect(matchRoute('POST', '/v1/sessions')?.route.operationId).toBe('createSession'); // default: harness
  });

  it('answers every harness-only route with the unknown-path 404 under the sandbox profile', async () => {
    const base = await serve('sandbox');
    const harnessOnly = ROUTES.filter((r) => !r.profiles.includes('sandbox'));
    expect(harnessOnly.length).toBeGreaterThan(10); // guards the guard
    const unknown = await fetch(`${base}/no/such/path`);
    const unknownBody = await unknown.json();
    for (const r of harnessOnly) {
      const res = await fetch(base + concrete(r.path), {
        method: r.method,
        headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        body: r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}',
      });
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
      expect(await res.json(), `${r.method} ${r.path}`).toEqual(unknownBody);
    }
  });

  it('still serves the harness routes under the default profile', async () => {
    const base = await serve('harness');
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401); // matched, then refused: no token
  });
});
