import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecConnOptions } from '@moca/sandbox-client';
import { afterEach, describe, expect, it } from 'vitest';
import { saveAuth } from '../src/config.js';
import { SBX_USAGE, sbxMain, sbxPaths } from '../src/sbx/cli.js';
import { hasUnpulled, MAX_FILE, repoId } from '../src/sbx/push.js';
import {
  LOGIN,
  SBX,
  TOKEN,
  URL_,
  cleanupTmp,
  fakeCp,
  git,
  localWorkspace,
  repo,
  sandbox,
  setup,
  type Handler,
} from './helpers/sbx.js';

afterEach(cleanupTmp);

const OTHER = 'sbx-fedcba9876543210fedcba9876';
const NEW = 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * A control plane holding sandboxes: GET/list/create/token, every call recorded. `create` makes
 * NEW (then NEW2…); `tokens` counts mints per id.
 */
function controlPlane(initial: ReturnType<typeof sandbox>[] = []) {
  const boxes = new Map(initial.map((s) => [s.id, s]));
  let created = 0;
  const route = (key: string): Handler | undefined => {
    const [method, path] = key.split(' ') as [string, string];
    if (method === 'POST' && path === '/v1/sandboxes') {
      return (req) => {
        const b = req.body as { template: string; name?: string; labels?: Record<string, string> };
        const id = created++ === 0 ? NEW : `${NEW.slice(0, -1)}${created}`;
        const s = sandbox({
          id,
          template: b.template,
          name: b.name ?? null,
          labels: b.labels ?? {},
        });
        boxes.set(id, s);
        return { status: 201, body: s };
      };
    }
    if (method === 'GET' && path === '/v1/sandboxes') {
      return () => ({ status: 200, body: { sandboxes: [...boxes.values()] } });
    }
    const m = /^\/v1\/sandboxes\/([^/]+)(\/token)?$/.exec(path);
    if (!m) return undefined;
    const s = boxes.get(m[1]!);
    if (!s)
      return () => ({
        status: 404,
        body: { error: 'sandbox_not_found', message: 'no such sandbox' },
      });
    if (method === 'GET' && !m[2]) return () => ({ status: 200, body: s });
    if (method === 'POST' && m[2]) {
      return () =>
        s.state === 'ready'
          ? { status: 200, body: { ...TOKEN, wsk: s.id } }
          : {
              status: 409,
              body: { error: 'sandbox_terminated', message: 'sandbox expired', reason: s.reason },
            };
    }
    return undefined;
  };
  const cp = fakeCp(
    new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? route(k) : undefined) }),
  );
  return {
    ...cp,
    boxes,
    posts: () => cp.calls.filter((c) => c.method === 'POST' && c.path === '/v1/sandboxes'),
  };
}

/** One workspace per sandbox id, as the worker keeps them: the exec factory picks by `wsk`. */
function workspaces(o: Parameters<typeof localWorkspace>[0] = {}) {
  const byId = new Map<string, ReturnType<typeof localWorkspace>>();
  const get = (id: string) => {
    if (!byId.has(id)) byId.set(id, localWorkspace(o));
    return byId.get(id)!;
  };
  let opened = 0;
  let closed = 0;
  const factory = (c: ExecConnOptions) => {
    opened++;
    return { exec: get(c.workspaceKey).exec, close: () => void closed++ };
  };
  return { get, factory, counts: () => ({ opened, closed }) };
}

function harness(
  o: { boxes?: ReturnType<typeof sandbox>[]; ws?: Parameters<typeof localWorkspace>[0] } = {},
) {
  const s = setup();
  const cp = controlPlane(o.boxes);
  const ws = workspaces(o.ws);
  const r = repo();
  const run = (argv: string[], over: { cwd?: string; env?: Record<string, string> } = {}) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    s.io.outB.length = 0;
    return sbxMain(argv, over.env ?? s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      cwd: over.cwd ?? r,
      execFactory: ws.factory,
    });
  };
  const err = () => s.io.errs.join('\n');
  return { ...s, cp, ws, r, run, err };
}

const binding = (r: string) => JSON.parse(readFileSync(join(r, '.sbx/sandbox.json'), 'utf8'));

describe('mocactl sbx up (SBX0 §6.1)', () => {
  it('creates a sandbox labelled with the repository id, pushes the tree, and binds it', async () => {
    const h = harness();
    expect(await h.run(['up', '--template', 'node22', '--name', 'web'])).toBe(0);
    expect(h.cp.posts()).toHaveLength(1);
    expect(h.cp.posts()[0]!.body).toEqual({
      template: 'node22',
      name: 'web',
      labels: { project: await repoId(h.r) },
    });
    const ws = h.ws.get(NEW).ws;
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    expect(readFileSync(join(ws, 'build/keep.txt'), 'utf8')).toBe('tracked under an ignored dir\n');
    expect(existsSync(join(ws, '.env'))).toBe(false);
    expect(binding(h.r)).toEqual({ id: NEW, controlPlaneUrl: URL_, template: 'node22' });
    expect(readFileSync(join(h.r, '.git/info/exclude'), 'utf8')).toContain('.sbx/');
    expect(git(h.r, 'status', '--porcelain')).not.toContain('.sbx');
    expect(h.io.outs.join('')).toBe(`${NEW}\n`); // stdout: only the id
    expect(h.err()).toMatch(/not pushed, as they may hold secrets .*: \.env, id_rsa/);
    expect(h.err()).toMatch(/pushed 7 files/);
    expect(h.err()).toContain(
      `sandbox ${NEW} (node22), expires ${new Date(1_800_604_800_000).toISOString()}`,
    );
    expect(h.ws.counts()).toEqual({ opened: 1, closed: 1 });
  });

  it('says in its usage that a reused sandbox with unpulled work is left unpushed', () => {
    expect(SBX_USAGE.replace(/\s+/g, ' ')).toContain(
      'a reused sandbox with changes not yet pulled is left unpushed, with a warning, and up exits 0',
    );
  });

  it('uses the default template when none is given (spec §6.1)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    expect(h.cp.posts()[0]!.body).toMatchObject({ template: 'default' });
    expect(binding(h.r).template).toBe('default');
  });

  it('reuses the bound sandbox when it is ready, and pushes again', async () => {
    const h = harness();
    expect(await h.run(['up', '--template', 'node22'])).toBe(0);
    writeFileSync(join(h.r, 'later.txt'), 'later\n');
    expect(await h.run(['up'])).toBe(0);
    expect(h.cp.posts()).toHaveLength(1);
    expect(h.cp.calls.some((c) => c.method === 'GET' && c.path === `/v1/sandboxes/${NEW}`)).toBe(
      true,
    );
    expect(readFileSync(join(h.ws.get(NEW).ws, 'later.txt'), 'utf8')).toBe('later\n');
  });

  it("reuses the user's newest ready sandbox labelled with this project, never another project's", async () => {
    const r0 = repo();
    const rid = await repoId(r0);
    const h = harness({
      boxes: [
        sandbox({ id: OTHER, labels: { project: 'someone-else' }, createdAt: 1_900_000_000 }),
        sandbox({ id: SBX, labels: { project: rid }, createdAt: 1_800_000_000 }),
      ],
    });
    // The same project: same repository id (no origin, so the root path: use r0 itself).
    expect(await h.run(['up'], { cwd: join(r0, 'src') })).toBe(0);
    expect(h.cp.posts()).toHaveLength(0);
    expect(binding(r0).id).toBe(SBX);
    expect(readFileSync(join(h.ws.get(SBX).ws, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    expect(h.err()).toContain(`reusing ${SBX}`);
  });

  it('warns and pushes nothing when the reused sandbox holds changes not yet pulled', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/app.py'), 'print("agent")\n');
    writeFileSync(join(h.r, 'local.txt'), 'local\n');
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).toMatch(/changes not yet pulled, so it was left as it is \(not pushed\)/);
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print("agent")\n'); // survives
    expect(existsSync(join(ws, 'local.txt'))).toBe(false);
  });

  it('creates a new sandbox when the bound one is terminated, saying so', async () => {
    const h = harness({
      boxes: [
        sandbox({ id: SBX, state: 'terminated', reason: 'expired', terminatedAt: 1_800_000_100 }),
      ],
    });
    mkdirSync(join(h.r, '.sbx'));
    writeFileSync(
      join(h.r, '.sbx/sandbox.json'),
      JSON.stringify({ id: SBX, controlPlaneUrl: URL_ }),
    );
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).toContain(
      `the bound sandbox ${SBX} is terminated (expired); finding or creating another`,
    );
    expect(h.cp.posts()).toHaveLength(1);
    expect(binding(h.r).id).toBe(NEW);
  });

  it('creates a new sandbox when the bound one no longer exists', async () => {
    const h = harness();
    mkdirSync(join(h.r, '.sbx'));
    writeFileSync(join(h.r, '.sbx/sandbox.json'), JSON.stringify({ id: OTHER }));
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).toContain(`the bound sandbox ${OTHER} no longer exists`);
    expect(binding(h.r).id).toBe(NEW);
  });

  it('refuses to reuse a bound sandbox of another template than --template asks', async () => {
    const h = harness({ boxes: [sandbox({ id: SBX, template: 'python' })] });
    mkdirSync(join(h.r, '.sbx'));
    writeFileSync(join(h.r, '.sbx/sandbox.json'), JSON.stringify({ id: SBX }));
    expect(await h.run(['up', '--template', 'node22'])).toBe(1);
    expect(h.err()).toMatch(/has template python, not node22/);
    expect(h.cp.posts()).toHaveLength(0);
  });

  it('refuses before creating anything: outside a repository, a file over 12 MiB, an IDN URL', async () => {
    const h = harness();
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-norepo-')));
    try {
      expect(await h.run(['up'], { cwd: plain })).toBe(2);
      expect(h.err()).toMatch(/not inside a git repository/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    writeFileSync(join(h.r, 'huge.bin'), Buffer.alloc(MAX_FILE + 1));
    expect(await h.run(['up'])).toBe(1);
    expect(h.err()).toContain(`huge.bin (12.0 MiB, ${MAX_FILE + 1} bytes)`);
    rmSync(join(h.r, 'huge.bin'));
    const idn = 'https://bücher.example.invalid';
    saveAuth(sbxPaths(h.paths), { ...LOGIN, controlPlaneUrl: idn });
    expect(await h.run(['up'], { env: { HOME: h.home, MOCACTL_SBX_URL: idn } })).toBe(1);
    expect(h.err()).toMatch(/xn--bcher-kva\.example\.invalid/);
    expect(h.cp.posts()).toHaveLength(0);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  it('refuses flags that are not its own, and --json', async () => {
    const h = harness();
    for (const argv of [
      ['up', '--force'],
      ['up', '--apply'],
      ['up', '-o', 'x'],
      ['up', '--json'],
      ['up', '--sandbox', SBX],
      ['up', 'extra'],
      ['push', '--template', 'x'],
      ['push', '--no-agent-config'],
      ['pull', '--force'],
      ['pull', '--include-secrets'],
      ['ls', '--max-push', '1'],
      ['push', '--max-push', '0'],
      ['push', '--max-push', '1.5'],
      ['up', '--template', ''],
      ['up', '--template', '  '],
      ['create', '--template', ''],
    ]) {
      expect(await h.run(argv), argv.join(' ')).toBe(2);
    }
    expect(h.cp.calls).toHaveLength(0);
  });
});

describe('mocactl sbx push and pull (SBX0 §6.2, §10.3)', () => {
  it('push is refused while changes are not yet pulled; --force pushes', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/app.py'), 'print("agent")\n');
    expect(await h.run(['push'])).toBe(1);
    expect(h.err()).toContain(
      'sbx: the sandbox has changes not yet pulled: run mocactl sbx pull, or push --force to discard them',
    );
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print("agent")\n');
    expect(await h.run(['push', '--force'])).toBe(0);
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    expect(h.err()).toMatch(new RegExp(`pushed 7 files \\(0\\.0 MiB\\) to ${NEW}`));
  });

  it("push is refused over the agent's new file in a source directory named build (review C1)", async () => {
    const h = harness();
    mkdirSync(join(h.r, 'src/main/java/acme/build'), { recursive: true });
    writeFileSync(join(h.r, 'src/main/java/acme/build/Old.java'), 'class Old {}\n');
    git(h.r, 'add', '-f', 'src');
    git(h.r, 'commit', '-qm', 'java');
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/main/java/acme/build/New.java'), 'class New {}\n');
    expect(await h.run(['push'])).toBe(1);
    expect(h.err()).toContain('changes not yet pulled');
    expect(readFileSync(join(ws, 'src/main/java/acme/build/New.java'), 'utf8')).toBe(
      'class New {}\n',
    );
  });

  it('push --max-push and --include-secrets', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.r, 'big.bin'), Buffer.alloc(2 << 20));
    expect(await h.run(['push', '--max-push', '1'])).toBe(1);
    expect(h.err()).toMatch(
      /over the 1\.0 MiB limit \(--max-push\); largest: \(top-level files\) 2\.0 MiB/,
    );
    expect(await h.run(['push', '--include-secrets'])).toBe(0);
    expect(readFileSync(join(h.ws.get(NEW).ws, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('pull prints the patch; --apply applies it and advances the baseline; then nothing to pull', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(ws, 'build/keep.txt'), 'agent edit\n');
    expect(await h.run(['pull'])).toBe(0);
    const patch = Buffer.concat(h.io.outB).toString();
    expect(patch).toContain('+print(2)');
    expect(patch).toContain('build/keep.txt');
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(1)\n'); // pull alone changes nothing
    expect(await h.run(['pull', '--apply'])).toBe(0);
    expect(h.io.outB).toEqual([]); // --apply prints no patch
    expect(h.err()).toMatch(/applied the sandbox's changes to 2 files \(\d+ bytes of patch\)/);
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(2)\n');
    expect(readFileSync(join(h.r, 'build/keep.txt'), 'utf8')).toBe('agent edit\n');
    expect(await h.run(['pull'])).toBe(0);
    expect(h.io.outB).toEqual([]);
    expect(h.err()).toBe('nothing to pull');
    // And so a push is no longer refused.
    expect(await h.run(['push'])).toBe(0);
  });

  it('pull -o FILE writes the patch there; pull --sandbox works outside a repository', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    expect(await h.run(['pull', '-o', 'out.patch'], { cwd: join(h.r, 'src') })).toBe(0);
    expect(readFileSync(join(h.r, 'src/out.patch'), 'utf8')).toContain('+print(2)');
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-norepo-')));
    try {
      expect(await h.run(['pull', '--sandbox', NEW], { cwd: plain })).toBe(0);
      expect(Buffer.concat(h.io.outB).toString()).toContain('+print(2)');
      expect(await h.run(['pull', '--apply', '--sandbox', NEW], { cwd: plain })).toBe(2);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('pull --apply over an uncommitted local edit is refused, and the baseline is not advanced', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const { exec } = h.ws.get(NEW);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(h.r, 'src/app.py'), 'print("local")\n');
    expect(await h.run(['pull', '--apply'])).toBe(1);
    expect(h.err()).toMatch(
      /local changes not yet committed \(src\/app\.py\).*; nothing was changed/,
    );
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print("local")\n');
    expect(await hasUnpulled(exec)).toBe(true);
  });

  it('refuses a patch over the 8 MiB output cap, applying nothing', async () => {
    const h = harness({ ws: { capBytes: 300 } });
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'x'.repeat(2000));
    expect(await h.run(['pull', '--apply'])).toBe(1);
    expect(h.err()).toMatch(/over 8 MiB as a patch, .*so nothing was pulled/);
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    expect(await h.run(['pull'])).toBe(1);
    expect(h.io.outB).toEqual([]);
  });

  it('push and pull use the bound sandbox and its control plane, from any subdirectory', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    // No MOCACTL_SBX_URL: the binding's URL is used (R5j), and the root is found from src/.
    expect(await h.run(['pull', '--apply'], { cwd: join(h.r, 'src'), env: { HOME: h.home } })).toBe(
      0,
    );
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(2)\n');
  });

  it('a terminated sandbox is the control plane answer (exit 1), never a sandbox failure', async () => {
    const h = harness({ boxes: [sandbox({ id: SBX, state: 'terminated', reason: 'deleted' })] });
    expect(await h.run(['push', '--sandbox', SBX])).toBe(1);
    expect(h.err()).toMatch(/sandbox expired/);
  });
});
