import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApiError, TOKEN_CODES } from '../api/errors.js';
import {
  codeValidity,
  deviceLogin,
  LoginCancelledError,
  LoginExpiredError,
  toCachedAuth,
} from '../core/auth.js';
import { describeError } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import { saveConfig } from '../config.js';
import type { Io } from '../headless.js';
import { setAuth, type Runtime } from '../runtime.js';
import type { SandboxApiClient, SbxDiscovery, SbxSandbox } from './api.js';

/** `mocactl sbx`'s exit codes (SBX0 §6.1), as `mocactl auth token`'s beyond 0 and 2. */
export const SBX_EXIT = { ok: 0, failed: 1, usage: 2, loginRequired: 3, unreachable: 4 } as const;

export interface SbxCtx {
  rt: Runtime;
  api: SandboxApiClient;
  url: string;
  io: Io;
  json: boolean;
  signal?: AbortSignal;
}

export const NOT_ENROLLED =
  'sbx: this GitHub account is not enrolled in the sandbox service; ask an operator to add it';

/**
 * One line per failure. A refusal from the control plane is exit 1 with its message; a network
 * failure (status 0) is exit 4; a token the control plane will not take any more is exit 3.
 */
export function fail(io: Io, err: unknown): number {
  if (err instanceof ApiError && err.status === 0) {
    io.err(`sbx: cannot reach the sandbox control plane: ${describeError(err)}`);
    return SBX_EXIT.unreachable;
  }
  if (err instanceof ApiError && err.code === 'not_enrolled') {
    io.err(NOT_ENROLLED);
  } else if (err instanceof ApiError && TOKEN_CODES.has(err.code)) {
    io.err('sbx: your sandbox-service login has expired: run `mocactl sbx login`');
    return SBX_EXIT.loginRequired;
  } else if (err instanceof ApiError && err.status === 404 && err.code !== 'sandbox_not_found') {
    // An unmounted route: a MOCA (harness profile) control plane, or one from before SBX0.
    io.err('sbx: that control plane has no sandbox routes: is it the sandbox service?');
  } else {
    io.err(`sbx: ${describeError(err)}`);
  }
  return SBX_EXIT.failed;
}

export async function cmdLogin(c: SbxCtx, remember: boolean): Promise<number> {
  if (!c.rt.cp) return SBX_EXIT.usage;
  try {
    // Refuse a MOCA control plane before a device code is shown: its login would be useless here.
    const d: SbxDiscovery = await c.api.sandboxDiscovery().catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return {};
      throw err;
    });
    if (d.profile !== 'sandbox') {
      c.io.err(
        `sbx: ${c.url} is not the sandbox service (its /v1/discovery has no sandbox profile)`,
      );
      return SBX_EXIT.usage;
    }
    const login = await deviceLogin(
      { cp: c.rt.cp, sleep: c.rt.sleep, now: c.rt.now },
      (s, attempt) =>
        c.io.err(
          `${attempt > 1 ? 'That code expired. ' : ''}Open ${sanitizeRemote(s.verificationUri)} and enter the code ` +
            `${sanitizeRemote(s.userCode)} (valid for ${codeValidity(s.expiresIn)})`,
        ),
      c.signal,
    );
    setAuth(c.rt, toCachedAuth(login, c.url));
    if (remember) saveConfig(c.rt.paths, { ...c.rt.config, sbxControlPlaneUrl: c.url });
    c.io.err(
      `logged in to the sandbox service as ${sanitizeRemote(login.displayName ?? login.subject)}`,
    );
    return SBX_EXIT.ok;
  } catch (err) {
    if (err instanceof LoginCancelledError) return 130;
    if (err instanceof LoginExpiredError) {
      c.io.err('sbx: the login code expired twice; run `mocactl sbx login` again');
      return SBX_EXIT.failed;
    }
    return fail(c.io, err);
  }
}

const when = (epochS: number) => new Date(epochS * 1000).toISOString();

export async function cmdTemplates(c: SbxCtx): Promise<number> {
  try {
    const ts = await c.api.listTemplates();
    if (c.json) c.io.out(JSON.stringify(ts) + '\n');
    else {
      for (const t of ts) {
        c.io.out(`${sanitizeRemote(t.id).padEnd(16)} ${sanitizeRemote(t.description)}\n`);
      }
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return fail(c.io, err);
  }
}

export async function cmdCreate(
  c: SbxCtx,
  body: { template: string; name?: string; labels?: Record<string, string> },
): Promise<number> {
  try {
    const s = await c.api.createSandbox(body);
    if (c.json) c.io.out(JSON.stringify(s) + '\n');
    else c.io.out(`${sanitizeRemote(s.id)}\n`);
    c.io.err(
      `created ${sanitizeRemote(s.id)} (${sanitizeRemote(s.template)}), expires ${when(s.expiresAt)}`,
    );
    return SBX_EXIT.ok;
  } catch (err) {
    return fail(c.io, err);
  }
}

function stateText(s: SbxSandbox): string {
  return s.state === 'terminated' ? `terminated (${s.reason ?? 'expired'})` : s.state;
}

export async function cmdLs(c: SbxCtx, all: boolean): Promise<number> {
  try {
    const ss = await c.api.listSandboxes({ all });
    if (c.json) {
      c.io.out(JSON.stringify(ss) + '\n');
      return SBX_EXIT.ok;
    }
    for (const s of ss) {
      const row = [
        s.id.padEnd(30),
        (s.name ?? '-').padEnd(16),
        s.template.padEnd(12),
        stateText(s).padEnd(22),
        when(s.expiresAt),
        ...(all ? [s.owner] : []),
      ].join(' ');
      c.io.out(sanitizeRemote(row) + '\n');
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return fail(c.io, err);
  }
}

export async function cmdRm(c: SbxCtx, id: string): Promise<number> {
  try {
    const r = await c.api.deleteSandbox(id);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    c.io.err(`${id} ${r.reason === 'expired' ? 'had already expired' : 'deleted'}`);
    return SBX_EXIT.ok;
  } catch (err) {
    return fail(c.io, err);
  }
}

export async function cmdToken(c: SbxCtx, id: string): Promise<number> {
  try {
    const t = await c.api.mintSandboxToken(id);
    c.io.out(
      (c.json ? JSON.stringify({ token: t.token, expiresAt: t.expiresAt }) : t.token) + '\n',
    );
    return SBX_EXIT.ok;
  } catch (err) {
    return fail(c.io, err);
  }
}

/** POSIX single quotes: safe to `eval`, whatever the control plane sent. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Write-then-rename into a 0700 directory, chmodding both, so the file is 0600 even when a
 * previous run (or a leftover temp file) left it otherwise.
 */
function writeCa(dir: string, name: string, pem: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

/**
 * Exports for a direct sandbox/v1 client (SBX0 §6.1, §7): where to dial, what to put in the
 * request, and the command that mints a token -- never the token itself, which lives 15 minutes.
 */
export async function cmdEnv(c: SbxCtx, id: string): Promise<number> {
  try {
    const t = await c.api.mintSandboxToken(id);
    const lines: Array<[string, string]> = [
      ['SBX_ADDR', sanitizeRemote(t.execEndpoint)],
      ['SBX_TLS', '1'],
      ['SBX_SANDBOX_ID', sanitizeRemote(t.wrk)],
      ['SBX_WORKSPACE_KEY', sanitizeRemote(t.wsk)],
      ['SBX_TOKEN_CMD', `mocactl sbx token ${id}`],
    ];
    if (t.execCa) {
      // Absolute even when XDG_STATE_HOME is relative: the line is meant for another process.
      const dir = resolve(c.rt.paths.stateDir, 'sbx');
      lines.push(['SBX_CA_FILE', writeCa(dir, `${id}-exec-ca.crt`, t.execCa)]);
    }
    for (const [k, v] of lines) c.io.out(`export ${k}=${q(v)}\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return fail(c.io, err);
  }
}
