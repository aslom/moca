import type { CpConfig } from './handlers.js';
import type { RouteProfile } from './routes.js';
import { DEFAULT_SANDBOX_ISSUER } from './sandbox-token.js';

/**
 * The sandbox profile's settings (SBX0 spec §4, §5). Every refusal happens at BOOT and names the
 * variable, never its value: a sandbox control plane that boots without an allow list would admit
 * every GitHub account, and one with a malformed template would 400 every create from a pod that
 * looks Ready.
 */
export interface SandboxTemplate {
  id: string;
  /** The worker sandbox_id serving it: one microvm-worker per template (spec §2). */
  worker: string;
  description: string;
  tools: string[];
}

export interface SandboxConfig {
  templates: SandboxTemplate[];
  /** `SH_ALLOWED_SUBJECTS`: who may log in and use the profile, besides admins (spec §4.2). */
  allowedSubjects: string[];
  /** `SH_SANDBOX_LIFETIME_SECONDS`: a sandbox expires this long after creation. */
  lifetimeS: number;
  /** `SH_SANDBOX_RETENTION_SECONDS`: a terminated record is kept this long. */
  retentionS: number;
  /** `SH_SANDBOX_TOKEN_TTL_SECONDS`: the sandbox token's lifetime (spec §4.3). */
  tokenTtlS: number;
  /** `SH_SANDBOX_MAX_PER_SUBJECT`: live sandboxes one subject may hold. */
  maxPerSubject: number;
  /** `SH_SANDBOX_MAX_TOTAL`: live sandboxes the deployment may hold. */
  maxTotal: number;
  /** `SH_SANDBOX_TOKEN_ISSUER`: the sandbox token's `iss`. */
  issuer: string;
  /** `SH_SANDBOX_EXEC_ENDPOINT`: host:port of the exec Route clients send Exec to. */
  execEndpoint: string;
  /** `SH_SANDBOX_EXEC_CA`: PEM, when the exec certificate is self-issued. */
  execCa?: string;
  /** `SH_JANITOR_TOKEN` (a credential), at least 32 characters; absent refuses the janitor's route. */
  janitorToken?: string;
}

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** The relay looks a worker up by this name (sandbox-relay main.ts SANDBOX_ID_RE). */
const WORKER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENDPOINT_RE = /^[A-Za-z0-9.-]+:[0-9]{1,5}$/;

/**
 * `SH_ROUTE_PROFILE`: exactly `harness` or `sandbox`; absent or empty means `harness`. A near-miss
 * (`Sandbox`, ` sandbox`) refuses to boot rather than mounting nothing, `/healthz` included. The
 * value is not echoed, as no boot refusal here echoes one.
 */
export function routeProfileFromEnv(env: NodeJS.ProcessEnv): RouteProfile {
  const v = env.SH_ROUTE_PROFILE || 'harness';
  if (v !== 'harness' && v !== 'sandbox') {
    throw new Error(`SH_ROUTE_PROFILE must be exactly 'harness' or 'sandbox'`);
  }
  return v;
}

function positive(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`${name} must be a positive integer`);
  return Number(v);
}

export function parseTemplates(raw: string | undefined): SandboxTemplate[] {
  if (!raw) {
    throw new Error(
      'SH_SANDBOX_TEMPLATES is required: a JSON list of {id, worker, description, tools}',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SH_SANDBOX_TEMPLATES is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('SH_SANDBOX_TEMPLATES must list at least one template');
  }
  const seen = new Set<string>();
  return parsed.map((t: unknown, i) => {
    const where = `SH_SANDBOX_TEMPLATES[${i}]`;
    const o = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !TEMPLATE_ID_RE.test(o.id)) {
      throw new Error(`${where}: id must match ${TEMPLATE_ID_RE}`);
    }
    if (typeof o.worker !== 'string' || !WORKER_RE.test(o.worker) || o.worker === 'DIR') {
      throw new Error(`${where}: worker must match ${WORKER_RE} and not be DIR`);
    }
    if (typeof o.description !== 'string') {
      throw new Error(`${where}: description must be a string`);
    }
    if (!Array.isArray(o.tools) || !o.tools.every((x) => typeof x === 'string')) {
      throw new Error(`${where}: tools must be a list of strings`);
    }
    if (seen.has(o.id)) throw new Error(`${where}: template id '${o.id}' is listed twice`);
    seen.add(o.id);
    return { id: o.id, worker: o.worker, description: o.description, tools: o.tools as string[] };
  });
}

export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv): SandboxConfig {
  const allowedSubjects = (env.SH_ALLOWED_SUBJECTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowedSubjects.length === 0) {
    throw new Error(
      'SH_ALLOWED_SUBJECTS is required on the sandbox profile: the enrolled subjects',
    );
  }
  const execEndpoint = env.SH_SANDBOX_EXEC_ENDPOINT ?? '';
  if (!ENDPOINT_RE.test(execEndpoint)) {
    throw new Error('SH_SANDBOX_EXEC_ENDPOINT must be host:port (the exec Route, e.g. <host>:443)');
  }
  const janitorToken = env.SH_JANITOR_TOKEN || undefined;
  if (janitorToken !== undefined && janitorToken.length < 32) {
    throw new Error('SH_JANITOR_TOKEN must be at least 32 characters');
  }
  return {
    templates: parseTemplates(env.SH_SANDBOX_TEMPLATES),
    allowedSubjects,
    lifetimeS: positive(env, 'SH_SANDBOX_LIFETIME_SECONDS', 7 * 86_400),
    retentionS: positive(env, 'SH_SANDBOX_RETENTION_SECONDS', 14 * 86_400),
    tokenTtlS: positive(env, 'SH_SANDBOX_TOKEN_TTL_SECONDS', 900),
    maxPerSubject: positive(env, 'SH_SANDBOX_MAX_PER_SUBJECT', 3),
    maxTotal: positive(env, 'SH_SANDBOX_MAX_TOTAL', 40),
    issuer: env.SH_SANDBOX_TOKEN_ISSUER || DEFAULT_SANDBOX_ISSUER,
    execEndpoint,
    ...(env.SH_SANDBOX_EXEC_CA ? { execCa: env.SH_SANDBOX_EXEC_CA } : {}),
    ...(janitorToken ? { janitorToken } : {}),
  };
}

/**
 * Who may use the sandbox profile (spec §4.2): the allow list, plus admins. The harness profile has
 * no allow list (MU1 admits any GitHub account), so this is always true there.
 */
export function isEnrolled(subject: string, roles: string[], config: CpConfig): boolean {
  if (config.routeProfile !== 'sandbox') return true;
  return roles.includes('admin') || (config.sandbox?.allowedSubjects ?? []).includes(subject);
}
