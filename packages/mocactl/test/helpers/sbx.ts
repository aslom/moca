import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, saveAuth } from '../../src/config.js';
import { sbxPaths } from '../../src/sbx/cli.js';

/** The fakes `mocactl sbx`'s tests share: a scripted control plane, a login, a sandbox, a token. */

export const URL_ = 'https://sbx-api.example.invalid';
export const SBX = 'sbx-0123456789abcdef0123456789';

export type Req = { method: string; path: string; body: unknown; auth?: string };
export type Handler = (req: Req) => { status: number; body?: unknown } | Error;

/** A scripted control plane: one handler per "METHOD /path", recording every call. */
export function fakeCp(routes: Record<string, Handler>) {
  const calls: Req[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const req: Req = {
      method: init?.method ?? 'GET',
      path: u.pathname + u.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    };
    calls.push(req);
    const h = routes[`${req.method} ${u.pathname}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const r = h(req);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const LOGIN = {
  apiToken: 'api-1',
  subject: 'github:1',
  roles: [],
  expiresAt: 4_000_000_000,
  controlPlaneUrl: URL_,
  refreshToken: 'mrt_x',
  refreshExpiresAt: 4_000_000_000,
};

export function setup(opts: { loggedIn?: boolean; expired?: boolean } = { loggedIn: true }) {
  const home = mkdtempSync(join(tmpdir(), 'mocactl-sbx-'));
  const env = { HOME: home, MOCACTL_SBX_URL: URL_ };
  const paths = resolvePaths(env, home);
  if (opts.loggedIn !== false) {
    // The sbx login lives in its own file (sbx-auth.json), never in MOCA's auth.json.
    saveAuth(sbxPaths(paths), { ...LOGIN, ...(opts.expired ? { expiresAt: 1_000 } : {}) });
  }
  // As main.ts wires it: text for mocactl's own messages, bytes for a remote command's output.
  const io = {
    outs: [] as string[],
    errs: [] as string[],
    outB: [] as Buffer[],
    errB: [] as Buffer[],
    out(s: string) {
      this.outs.push(s);
    },
    err(s: string) {
      this.errs.push(s);
    },
    outBytes(b: Uint8Array) {
      this.outB.push(Buffer.from(b));
    },
    errBytes(b: Uint8Array) {
      this.errB.push(Buffer.from(b));
    },
  };
  return { home, env, paths, io };
}

export const sandbox = (over: Record<string, unknown> = {}) => ({
  id: SBX,
  owner: 'github:1',
  name: 'web',
  template: 'node22',
  state: 'ready',
  reason: null,
  createdAt: 1_800_000_000,
  expiresAt: 1_800_604_800,
  terminatedAt: null,
  labels: {},
  ...over,
});

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** An unsigned JWT with the claims mocactl reads (unverified): `iat` and `exp`. */
export const jwt = (claims: { iat: number; exp: number }) =>
  `${b64url({ alg: 'EdDSA', typ: 'JWT' })}.${b64url({ sbx: SBX, ...claims })}.sig`;

/** The token's lifetime is 900 s (`exp − iat`): the default timeout is 840 s. */
export const TOKEN_IAT = 1_800_000_000;
export const TOKEN = {
  token: jwt({ iat: TOKEN_IAT, exp: 1_800_000_900 }),
  expiresAt: 1_800_000_900,
  execEndpoint: 'sbx-exec.example.invalid:443',
  wrk: 'sbx_node22',
  wsk: SBX,
  execCa: null,
};
