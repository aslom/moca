import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '@moca/sandbox-client';
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

/** Temp directories made by `localWorkspace` and `repo`, removed by `cleanupTmp` (afterEach). */
const made: string[] = [];
export function cleanupTmp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

/**
 * The tools a sandbox Exec may need, linked into a bin directory of their own, so a test can take
 * one away (`without: ['tar']`: the Python fallback). `python3` is resolved to its real binary
 * (a pyenv shim needs pyenv on PATH).
 */
function toolDir(without: string[]): string {
  const bin = tmp('sbx-bin-');
  const tools = ['bash', 'sh', 'git', 'tar', 'gzip', 'find', 'rm', 'mkdir', 'mktemp', 'mv', 'head'];
  for (const t of [...tools, 'cat', 'wc', 'ls', 'env', 'dirname', 'basename', 'sed', 'tr']) {
    if (without.includes(t)) continue;
    const r = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' });
    if (r.status === 0) symlinkSync(r.stdout.trim(), join(bin, t));
  }
  if (!without.includes('python3')) {
    const r = spawnSync('python3', ['-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8',
    });
    if (r.status === 0) symlinkSync(r.stdout.trim(), join(bin, 'python3'));
  }
  return bin;
}

/**
 * A temp directory standing in for /workspace: each command runs in a real bash with `/workspace`
 * rewritten to it, as the worker would run it. `capBytes` cuts stdout as the worker's 8 MiB cap
 * does (`truncated`); `without` hides tools from PATH; `sent` records every command and stdin.
 */
export function localWorkspace(o: { capBytes?: number; without?: string[] } = {}) {
  const ws = tmp('sbx-ws-');
  const env = o.without?.length ? { ...process.env, PATH: toolDir(o.without) } : process.env;
  const sent: { command: string; stdin?: Buffer; timeoutS?: number }[] = [];
  const exec: Exec = (command, x = {}) =>
    new Promise((resolve) => {
      sent.push({
        command,
        ...(x.stdin ? { stdin: Buffer.from(x.stdin) } : {}),
        ...(x.timeoutS !== undefined ? { timeoutS: x.timeoutS } : {}),
      });
      const child = execFile(
        'bash',
        ['-c', command.replaceAll('/workspace', ws)],
        { encoding: 'buffer', maxBuffer: 512 << 20, env },
        (err, stdout, stderr) => {
          const code = err ? (err as { code?: unknown }).code : 0;
          const cut = o.capBytes !== undefined && stdout.length > o.capBytes;
          resolve({
            stdout: cut ? stdout.subarray(0, o.capBytes) : stdout,
            stderr,
            exitCode: typeof code === 'number' ? code : -1,
            truncated: cut,
          });
        },
      );
      child.stdin!.end(x.stdin ? Buffer.from(x.stdin) : undefined);
    });
  return { ws, exec, sent };
}

/** Runs git in `cwd`, returning stdout as text. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A real repository with what a push must get right (plan 1c Review Focus 1): a space and unicode
 * in names, an executable, a symlink, a tracked file under a .gitignore'd directory, an ignored
 * file, an untracked file, and two untracked would-be secrets.
 */
export function repo(): string {
  const r = tmp('sbx-repo-');
  git(r, 'init', '-q');
  git(r, 'config', 'user.email', 't@example.invalid');
  git(r, 'config', 'user.name', 't');
  git(r, 'config', 'commit.gpgSign', 'false');
  mkdirSync(join(r, 'src'));
  writeFileSync(join(r, 'src/app.py'), 'print(1)\n');
  writeFileSync(join(r, '.gitignore'), 'build/\n');
  mkdirSync(join(r, 'build'));
  writeFileSync(join(r, 'build/keep.txt'), 'tracked under an ignored dir\n');
  writeFileSync(join(r, 'build/out.o'), 'ignored\n');
  mkdirSync(join(r, 'bin'));
  writeFileSync(join(r, 'bin/run.sh'), '#!/bin/sh\necho run\n');
  chmodSync(join(r, 'bin/run.sh'), 0o755);
  mkdirSync(join(r, 'dir with space'));
  writeFileSync(join(r, 'dir with space/ünï.txt'), 'u\n');
  symlinkSync('src/app.py', join(r, 'latest'));
  writeFileSync(join(r, '.env'), 'SECRET=1\n');
  writeFileSync(join(r, 'id_rsa'), 'key\n');
  git(r, 'add', 'src', '.gitignore', 'bin', 'dir with space', 'latest');
  git(r, 'add', '-f', 'build/keep.txt');
  git(r, 'commit', '-qm', 'init');
  writeFileSync(join(r, 'notes.md'), 'untracked, not ignored\n');
  return r;
}
