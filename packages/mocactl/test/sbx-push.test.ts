import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MAX_STDIN_BYTES } from '@moca/sandbox-client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILD_EXCLUDES,
  CHUNK_TARGET,
  DEFAULT_MAX_PUSH,
  MAX_FILE,
  MAX_STDIN,
  PushError,
  advanceBaseline,
  applyPatch,
  bindingUrl,
  capture,
  capturePatch,
  hasUnpulled,
  isBindingPath,
  planPush,
  pushTree,
  repoId,
  reincludes,
  repoRoot,
  sandboxState,
  writeBinding,
} from '../src/sbx/push.js';
import { readBinding } from '../src/sbx/state.js';
import { SBX, cleanupTmp, git, localWorkspace, repo } from './helpers/sbx.js';

afterEach(cleanupTmp);

/** Skipped only off CI when the tool is missing: under CI the real-tool tests must run (R6f). */
const missing = (cmd: string) => !process.env.CI && Boolean(spawnSync(cmd, ['--version']).error);

/** Every file under `d` (not .git), with its kind, mode and content: a tree's fingerprint. */
function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const files = execFileSync('find', ['.', '-path', './.git', '-prune', '-o', '-print0'], {
    cwd: d,
  })
    .toString()
    .split('\0')
    .filter((f) => f && f !== '.' && f !== './.git');
  for (const f of files) {
    const p = join(d, f);
    const st = lstatSync(p);
    const key = f.slice(2).normalize('NFC');
    if (st.isSymbolicLink()) out[key] = `link:${readlinkSync(p).normalize('NFC')}`;
    else if (st.isFile()) out[key] = `${st.mode & 0o111 ? 'x' : '-'}:${readFileSync(p, 'hex')}`;
  }
  return out;
}

const pushed = async (r: string, o: Parameters<typeof localWorkspace>[0] = {}) => {
  const w = localWorkspace(o);
  await pushTree(w.exec, await planPush(r));
  return w;
};

describe('the push list (SBX0 §6.2)', () => {
  it('lists tracked files (even under an ignored dir) and untracked ones, never ignored ones or secrets', async () => {
    const plan = await planPush(repo());
    expect(plan.excludedSecrets.sort()).toEqual(['.env', 'id_rsa']);
    // .gitignore, src/app.py, build/keep.txt, bin/run.sh, ünï.txt, latest, notes.md
    expect(plan.paths.sort()).toEqual(
      [
        '.gitignore',
        'bin/run.sh',
        'build/keep.txt',
        'dir with space/ünï.txt',
        'latest',
        'notes.md',
        'src/app.py',
      ].sort(),
    );
    expect(plan.files).toBe(7);
    expect(plan.skipped).toEqual([]);
  });

  it('includes the secrets only when asked, and matches each pattern on the basename', async () => {
    const r = repo();
    mkdirSync(join(r, 'conf'));
    for (const f of ['conf/.env.local', 'conf/tls.pem', 'conf/tls.key', 'conf/id_ed25519']) {
      writeFileSync(join(r, f), 's');
    }
    writeFileSync(join(r, 'conf/keys.md'), 'not a secret');
    const plan = await planPush(r);
    expect(plan.excludedSecrets.sort()).toEqual(
      [
        '.env',
        'conf/.env.local',
        'conf/id_ed25519',
        'conf/tls.key',
        'conf/tls.pem',
        'id_rsa',
      ].sort(),
    );
    expect(plan.paths).toContain('conf/keys.md');
    const all = await planPush(r, { includeSecrets: true });
    expect(all.excludedSecrets).toEqual([]);
    expect(all.paths).toEqual(expect.arrayContaining(['.env', 'id_rsa', 'conf/tls.key']));
  });

  it('skips a deleted tracked file silently, and names a nested repository it does not push', async () => {
    const r = repo();
    unlinkSync(join(r, 'src/app.py'));
    mkdirSync(join(r, 'vendor/lib'), { recursive: true });
    git(join(r, 'vendor/lib'), 'init', '-q');
    writeFileSync(join(r, 'vendor/lib/x.c'), 'x');
    const plan = await planPush(r);
    expect(plan.paths).not.toContain('src/app.py');
    expect(plan.skipped).toEqual([expect.stringMatching(/^vendor\/lib .*not pushed/)]);
  });

  it('never reads through a symlinked parent: a tracked dir replaced by a link to outside (review I2)', async () => {
    const r = repo();
    const outside = join(r, '..', `${r.split('/').pop()}-outside`);
    mkdirSync(outside);
    try {
      writeFileSync(join(outside, 'settings.py'), 'OUTSIDE SECRET\n');
      mkdirSync(join(r, 'conf'));
      writeFileSync(join(r, 'conf/settings.py'), 'inrepo\n');
      git(r, 'add', 'conf');
      git(r, 'commit', '-qm', 'conf');
      rmSync(join(r, 'conf'), { recursive: true });
      symlinkSync(outside, join(r, 'conf'));
      const plan = await planPush(r);
      expect(plan.paths).not.toContain('conf/settings.py');
      expect(plan.skipped).toEqual([
        expect.stringMatching(/^conf\/settings\.py \(under the symlink conf: not pushed/),
      ]);
      expect(plan.chunks.some((c) => gunzipSync(c).includes('OUTSIDE SECRET'))).toBe(false);
      expect(plan.paths).toContain('conf'); // the link itself goes, as a link
      const { ws, exec } = localWorkspace();
      await pushTree(exec, plan);
      expect(lstatSync(join(ws, 'conf')).isSymbolicLink()).toBe(true);
      expect(await hasUnpulled(exec)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never pushes .sbx/, even when it is not excluded', async () => {
    const r = repo();
    mkdirSync(join(r, '.sbx'));
    writeFileSync(join(r, '.sbx/sandbox.json'), '{}');
    expect((await planPush(r)).paths.some((p) => p.startsWith('.sbx/'))).toBe(false);
  });

  it('refuses a file over 12 MiB by name, and a tree over --max-push with its largest directories', async () => {
    const r = repo();
    writeFileSync(join(r, 'huge.bin'), Buffer.alloc(MAX_FILE + 1));
    await expect(planPush(r)).rejects.toThrow(/huge\.bin \(12\.0 MiB\)/);
    const small = repo();
    const err = await planPush(small, { maxPush: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushError);
    expect((err as Error).message).toMatch(/over the .* limit; largest: build|bin|src|\./);
    expect((err as Error).message).toContain('--max-push');
  });

  it('is exactly at the limits it names', () => {
    expect(CHUNK_TARGET).toBe(8 << 20);
    expect(MAX_FILE).toBe(12 << 20);
    expect(MAX_STDIN).toBe(MAX_STDIN_BYTES);
    expect(DEFAULT_MAX_PUSH).toBe(256 << 20);
    expect(BUILD_EXCLUDES).toEqual([
      '__pycache__/',
      '*.pyc',
      'node_modules/',
      '.venv/',
      'venv/',
      '.pytest_cache/',
      '.mypy_cache/',
      'dist/',
      'build/',
      'target/',
    ]);
  });

  it('splits a large tree into several Execs, each under the stdin ceiling', async () => {
    const r = repo();
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(r, `blob${i}.bin`),
        Buffer.from(Array.from({ length: 5 << 20 }, () => Math.floor(Math.random() * 256))),
      );
    }
    // One file just under the per-file limit, incompressible: its chunk is the largest possible.
    writeFileSync(
      join(r, 'big.bin'),
      Buffer.from(Array.from({ length: MAX_FILE - 4096 }, () => Math.floor(Math.random() * 256))),
    );
    const plan = await planPush(r);
    expect(plan.chunks.length).toBeGreaterThan(2);
    for (const c of plan.chunks) expect(c.length).toBeLessThanOrEqual(MAX_STDIN);
    const { ws, exec, sent } = localWorkspace();
    await pushTree(exec, plan);
    expect(sent.filter((s) => s.stdin && s.stdin.length > 0).length).toBeGreaterThan(
      plan.chunks.length - 1,
    );
    for (const s of sent) expect(s.stdin?.length ?? 0).toBeLessThanOrEqual(MAX_STDIN_BYTES);
    expect(statSync(join(ws, 'blob2.bin')).size).toBe(5 << 20);
    expect(readFileSync(join(ws, 'big.bin'))).toEqual(readFileSync(join(r, 'big.bin')));
    expect(await hasUnpulled(exec)).toBe(false);
  }, 120_000);
});

describe('push into the sandbox (SBX0 §6.2)', () => {
  it.skipIf(missing('tar'))(
    'round-trips the tree with modes and symlinks, and commits a clean baseline (tar)',
    async () => {
      const r = repo();
      const { ws, exec } = await pushed(r);
      expect(readFileSync(join(ws, 'build/keep.txt'), 'utf8')).toBe(
        'tracked under an ignored dir\n',
      );
      expect(existsSync(join(ws, 'build/out.o'))).toBe(false);
      expect(existsSync(join(ws, '.env'))).toBe(false);
      expect(statSync(join(ws, 'bin/run.sh')).mode & 0o111).not.toBe(0);
      expect(statSync(join(ws, 'src/app.py')).mode & 0o111).toBe(0);
      expect(readlinkSync(join(ws, 'latest'))).toBe('src/app.py');
      expect(readFileSync(join(ws, 'dir with space/ünï.txt'), 'utf8')).toBe('u\n');
      expect(await hasUnpulled(exec)).toBe(false);
      // The baseline is exactly the pushed list: the tracked file under build/ is in it.
      expect(git(ws, 'ls-files').split('\n')).toContain('build/keep.txt');
      expect(readFileSync(join(ws, '.git/info/exclude'), 'utf8')).toContain('node_modules/\n');
    },
  );

  it.skipIf(missing('python3'))('extracts with python3 when the sandbox has no tar', async () => {
    const r = repo();
    const { ws, exec, sent } = await pushed(r, { without: ['tar'] });
    expect(sent[0]!.command).toContain('python3');
    expect(readlinkSync(join(ws, 'latest'))).toBe('src/app.py');
    expect(statSync(join(ws, 'bin/run.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(ws, 'dir with space/ünï.txt'), 'utf8')).toBe('u\n');
    expect(await hasUnpulled(exec)).toBe(false);
  });

  it('empties the workspace on a re-push, keeping only lost+found', async () => {
    const { ws, exec } = localWorkspace();
    writeFileSync(join(ws, 'stale'), 'old');
    mkdirSync(join(ws, 'lost+found'));
    mkdirSync(join(ws, 'old dir/deep'), { recursive: true });
    await pushTree(exec, await planPush(repo()));
    expect(existsSync(join(ws, 'stale'))).toBe(false);
    expect(existsSync(join(ws, 'old dir'))).toBe(false);
    expect(existsSync(join(ws, 'lost+found'))).toBe(true);
    expect(await hasUnpulled(exec)).toBe(false);
  });

  it('quotes every path it sends: a name with shell and pathspec syntax round-trips', async () => {
    const r = repo();
    for (const f of ["it's $(x) *.c", ':(exclude)src', '-n', 'tab\there'])
      writeFileSync(join(r, f), f);
    const { ws, exec } = await pushed(r);
    for (const f of ["it's $(x) *.c", ':(exclude)src', '-n', 'tab\there']) {
      expect(readFileSync(join(ws, f), 'utf8')).toBe(f);
    }
    expect(await hasUnpulled(exec)).toBe(false);
  });
});

describe('the round trip: up -> sandbox -> pull (plan 1c Review Focus 1)', () => {
  for (const [reader, without] of [
    ['tar', []],
    ['python3', ['tar']],
  ] as const) {
    it.skipIf(missing(reader))(
      `brings back the agent's every kind of change, byte for byte (${reader})`,
      async () => {
        const r = repo();
        const LONG = `${'long dir name/'.repeat(8)}fïle with a long name.txt`; // > 100 bytes
        mkdirSync(join(r, LONG, '..'), { recursive: true });
        writeFileSync(join(r, LONG), 'long\n');
        writeFileSync(join(r, 'tool.sh'), '#!/bin/sh\n');
        git(r, 'add', '-A');
        git(r, 'commit', '-qm', 'more');
        const { ws, exec } = await pushed(r, { without: [...without] });
        // What the agent does in the sandbox:
        writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
        writeFileSync(join(ws, 'build/keep.txt'), 'edited under an ignored dir\n'); // R6b
        writeFileSync(join(ws, 'dir with space/ünï.txt'), 'ü2\n');
        mkdirSync(join(ws, 'nëw dir'));
        writeFileSync(join(ws, 'nëw dir/文件 2.md'), 'new\n');
        writeFileSync(join(ws, LONG), 'longer\n');
        chmodSync(join(ws, 'tool.sh'), 0o755); // a mode-only change
        chmodSync(join(ws, 'bin/run.sh'), 0o644);
        unlinkSync(join(ws, 'latest'));
        symlinkSync('bin/run.sh', join(ws, 'latest')); // a symlink retargeted
        symlinkSync('src/app.py', join(ws, 'new link'));
        writeFileSync(join(ws, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 10]));
        unlinkSync(join(ws, 'notes.md'));
        mkdirSync(join(ws, 'node_modules/x'), { recursive: true });
        writeFileSync(join(ws, 'node_modules/x/i.js'), 'build output');
        mkdirSync(join(ws, 'dist'));
        writeFileSync(join(ws, 'dist/new.o'), 'build output');
        expect(await hasUnpulled(exec)).toBe(true);
        const patch = await capturePatch(exec);
        await applyPatch(r, patch);
        // The local tree is now the sandbox's, apart from what is excluded on either side.
        const local = snapshot(r);
        const remote = snapshot(ws);
        for (const k of ['build/out.o', '.env', 'id_rsa']) delete local[k]; // never pushed
        for (const k of ['node_modules/x/i.js', 'dist/new.o']) delete remote[k]; // build output
        delete remote['lost+found'];
        expect(local).toEqual(remote);
        const hex = (t: string) => Buffer.from(t).toString('hex');
        expect(local['build/keep.txt']).toBe(`-:${hex('edited under an ignored dir\n')}`);
        expect(local['tool.sh']).toMatch(/^x:/);
        expect(local['bin/run.sh']).toMatch(/^-:/);
        expect(local['latest']).toBe('link:bin/run.sh');
        expect(local[LONG]).toBe(`-:${hex('longer\n')}`);
        expect(local['notes.md']).toBeUndefined();
      },
      60_000,
    );
  }
});

describe('directories named like build output that hold source (review C1)', () => {
  /** A Java package named `build` (tracked), and a top-level build/ that really is output. */
  function javaRepo() {
    const r = repo();
    mkdirSync(join(r, 'src/main/java/acme/build'), { recursive: true });
    writeFileSync(join(r, 'src/main/java/acme/build/Old.java'), 'class Old {}\n');
    git(r, 'add', '-f', 'src');
    git(r, 'commit', '-qm', 'java');
    return r;
  }

  it("counts the agent's new file there as not yet pulled, pulls it, and a push is refused", async () => {
    const r = javaRepo();
    const { ws, exec } = await pushed(r);
    expect(await hasUnpulled(exec)).toBe(false);
    writeFileSync(join(ws, 'src/main/java/acme/build/New.java'), 'class New {}\n');
    mkdirSync(join(ws, 'src/main/java/acme/build/sub'));
    writeFileSync(join(ws, 'src/main/java/acme/build/sub/Deep.java'), 'class Deep {}\n');
    expect(await hasUnpulled(exec)).toBe(true);
    const patch = (await capturePatch(exec)).toString();
    expect(patch).toContain('src/main/java/acme/build/New.java');
    expect(patch).toContain('src/main/java/acme/build/sub/Deep.java');
    // And so a push (without --force) would be refused rather than discard it.
  });

  it("beats the repository's own .gitignore for that directory, as the push did", async () => {
    const r = javaRepo(); // .gitignore has build/, which matches acme/build/ too
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'src/main/java/acme/build/New.java'), 'class New {}\n');
    expect(await hasUnpulled(exec)).toBe(true);
    const { patch, tree } = await capture(exec);
    expect(patch.toString()).toContain('New.java');
    await applyPatch(r, patch);
    await advanceBaseline(exec, undefined, tree);
    expect(await hasUnpulled(exec)).toBe(false);
    expect(readFileSync(join(r, 'src/main/java/acme/build/New.java'), 'utf8')).toBe(
      'class New {}\n',
    );
  });

  it('keeps real build output excluded: node_modules/ inside the package, an untracked build/, dist/ with a .gitkeep', async () => {
    const r = javaRepo();
    mkdirSync(join(r, 'dist'));
    writeFileSync(join(r, 'dist/.gitkeep'), '');
    git(r, 'add', '-f', 'dist/.gitkeep');
    git(r, 'commit', '-qm', 'keep');
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'dist/bundle.js'), 'output');
    mkdirSync(join(ws, 'src/main/java/acme/build/node_modules'));
    writeFileSync(join(ws, 'src/main/java/acme/build/node_modules/x.js'), 'output');
    mkdirSync(join(ws, 'other/build'), { recursive: true });
    writeFileSync(join(ws, 'other/build/y.o'), 'output');
    expect(await hasUnpulled(exec)).toBe(false);
    expect((await capturePatch(exec)).toString()).toBe('');
  });

  it('re-includes exactly the build-named directories that hold pushed paths, literally', () => {
    expect(
      reincludes([
        'src/main/java/acme/build/Old.java',
        'build/keep.txt',
        'a/node_modules/b/dist/c.js',
        'we ird*/target/x',
        'src/app.py',
      ]),
    ).toEqual([
      '!/a/node_modules/',
      '!/a/node_modules/b/dist/',
      '!/build/',
      '!/src/main/java/acme/build/',
      '!/we\\ ird\\*/target/',
    ]);
    expect(reincludes(['dist/.gitkeep', 'out/build/.keep'])).toEqual([]);
  });

  it('treats a build-named directory holding a tracked file as source: new files there come back', async () => {
    const r = repo(); // build/keep.txt is tracked under the ignored build/
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'build/notes.txt'), 'the agent wrote this\n');
    expect(await hasUnpulled(exec)).toBe(true);
    expect((await capturePatch(exec)).toString()).toContain('build/notes.txt');
  });
});

describe('pull (SBX0 §6.2, §10.3)', () => {
  it("brings the sandbox's changes back as a patch that applies, then advances the baseline", async () => {
    const r = repo();
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(ws, 'src/new.py'), 'new\n');
    expect(await hasUnpulled(exec)).toBe(true);
    const { patch, tree } = await capture(exec);
    await applyPatch(r, patch);
    expect(readFileSync(join(r, 'src/app.py'), 'utf8')).toBe('print(2)\n');
    expect(readFileSync(join(r, 'src/new.py'), 'utf8')).toBe('new\n');
    // The plain path changes no index entry: the user's staging is theirs (R6c).
    expect(git(r, 'status', '--porcelain', '--', 'src')).toBe(' M src/app.py\n?? src/new.py\n');
    await advanceBaseline(exec, undefined, tree);
    expect(await hasUnpulled(exec)).toBe(false);
    expect((await capturePatch(exec)).length).toBe(0);
  });

  it("advancing to a captured tree hashes nothing again, and keeps the agent's own staging", async () => {
    const r = repo();
    const { ws, exec, sent } = await pushed(r);
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(ws, 'notes.md'), 'staged by the agent\n');
    const { patch, tree } = await capture(exec);
    git(ws, 'add', 'notes.md'); // the agent's own staging, after the capture
    await applyPatch(r, patch);
    sent.length = 0;
    await advanceBaseline(exec, undefined, tree);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.command).not.toContain('add -A'); // no second hash of the workspace
    // The pulled path is clean for the agent's git; its own staged notes.md is still staged.
    expect(git(ws, 'status', '--porcelain', '--', 'src/app.py')).toBe('');
    expect(git(ws, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(ws, 'ls-files', '-s', 'notes.md')).not.toBe('');
    expect(await hasUnpulled(exec)).toBe(false);
  });

  it("keeps the agent's staging of a file it changed after the capture", async () => {
    const { ws, exec } = await pushed(repo());
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    const { tree } = await capture(exec);
    writeFileSync(join(ws, 'bin/run.sh'), '#!/bin/sh\necho later\n');
    git(ws, 'add', 'bin/run.sh');
    await advanceBaseline(exec, undefined, tree);
    expect(git(ws, 'diff', '--cached', '--name-only')).toBe('bin/run.sh\n');
    expect(await hasUnpulled(exec)).toBe(true);
  });

  it('advances the baseline to what was captured, so a change made meanwhile is pulled next time', async () => {
    const r = repo();
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    const { patch, tree } = await capture(exec);
    writeFileSync(join(ws, 'src/late.py'), 'late\n'); // the agent keeps working
    await applyPatch(r, patch);
    await advanceBaseline(exec, undefined, tree);
    expect(await hasUnpulled(exec)).toBe(true);
    const next = (await capturePatch(exec)).toString();
    expect(next).toContain('src/late.py');
    expect(next).not.toContain('src/app.py');
  });

  it("counts the agent's own commits as not yet pulled, and brings them back", async () => {
    const r = repo();
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'src/app.py'), 'print(3)\n');
    git(ws, '-c', 'user.name=a', '-c', 'user.email=a@example.invalid', 'commit', '-qam', 'agent');
    expect(git(ws, 'status', '--porcelain')).toBe(''); // git status alone would say clean
    expect(await hasUnpulled(exec)).toBe(true);
    const { patch, tree } = await capture(exec);
    expect(patch.toString()).toContain('+print(3)');
    await applyPatch(r, patch);
    await advanceBaseline(exec, undefined, tree);
    expect(await hasUnpulled(exec)).toBe(false);
    expect(git(ws, 'log', '-1', '--format=%s')).toBe('agent\n'); // its HEAD is left alone
  });

  it('never brings back a .sbx/ the agent wrote, which would repoint the binding', async () => {
    const { ws, exec } = await pushed(repo());
    mkdirSync(join(ws, '.sbx'));
    writeFileSync(join(ws, '.sbx/sandbox.json'), '{"id":"sbx-evil"}');
    expect((await capturePatch(exec)).toString()).toBe('');
  });

  it("refuses a patch that would write the repository's .sbx/ binding", async () => {
    const r = repo();
    writeBinding(r, {
      id: SBX,
      controlPlaneUrl: 'https://sbx-api.example.invalid',
      template: 'default',
    });
    const { ws, exec } = await pushed(r);
    // An agent that takes .sbx/ out of the sandbox's exclude and writes a binding of its own.
    writeFileSync(join(ws, '.git/info/exclude'), '');
    mkdirSync(join(ws, '.sbx'));
    writeFileSync(join(ws, '.sbx/sandbox.json'), '{"id":"sbx-evil"}');
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    const patch = await capturePatch(exec);
    expect(patch.toString()).toContain('.sbx/sandbox.json');
    await expect(applyPatch(r, patch)).rejects.toThrow(
      /\.sbx\/sandbox\.json, this repository's sandbox binding/,
    );
    expect(readBinding(r)?.id).toBe(SBX);
    expect(readFileSync(join(r, 'src/app.py'), 'utf8')).toBe('print(1)\n');
  });

  for (const dir of ['.SBX', '.Sbx']) {
    it(`refuses a patch writing ${dir}/, which a case-insensitive filesystem resolves to .sbx/ (review I3)`, async () => {
      const r = repo();
      writeBinding(r, {
        id: SBX,
        controlPlaneUrl: 'https://sbx-api.example.invalid',
        template: 'default',
      });
      const before = readFileSync(join(r, '.sbx/sandbox.json'));
      const patch = Buffer.from(
        `diff --git a/${dir}/sandbox.json b/${dir}/sandbox.json\n` +
          'new file mode 100644\nindex 0000000..1111111\n--- /dev/null\n' +
          `+++ b/${dir}/sandbox.json\n@@ -0,0 +1 @@\n+{"id":"sbx-evil"}\n`,
      );
      await expect(applyPatch(r, patch)).rejects.toThrow(/sandbox binding/);
      expect(readFileSync(join(r, '.sbx/sandbox.json'))).toEqual(before);
    });
  }

  it('matches the binding directory in any case or normalization, and nothing else', () => {
    for (const p of ['.sbx', '.sbx/sandbox.json', '.SBX/x', '.Sbx/x', '.sBX']) {
      expect(isBindingPath(p), p).toBe(true);
    }
    for (const p of ['src/.sbx/x', '.sbxx/x', 'sbx/x', '.sb'])
      expect(isBindingPath(p), p).toBe(false);
  });

  it('never pushes .SBX/ either, but does push a lookalike such as .SBX_dir/', async () => {
    const r = repo();
    mkdirSync(join(r, '.SBX'));
    writeFileSync(join(r, '.SBX/sandbox.json'), '{}');
    mkdirSync(join(r, '.SBX_dir'));
    writeFileSync(join(r, '.SBX_dir/x'), 'kept');
    const { paths } = await planPush(r);
    expect(paths.some((p) => p.toLowerCase().startsWith('.sbx/'))).toBe(false);
    expect(paths).toContain('.SBX_dir/x');
  });

  it('refuses a malformed patch with a readable error, changing nothing', async () => {
    const r = repo();
    await expect(
      applyPatch(r, Buffer.from('diff --git a/x b/x\ngarbage\n')),
    ).rejects.toBeInstanceOf(PushError);
    expect(git(r, 'status', '--porcelain', '--', 'src')).toBe('');
  });

  it('never brings back build output the baseline excludes', async () => {
    const { ws, exec } = await pushed(repo());
    mkdirSync(join(ws, 'src/__pycache__'));
    writeFileSync(join(ws, 'src/__pycache__/app.cpython-312.pyc'), 'x');
    expect((await capturePatch(exec)).toString()).toBe('');
  });

  it('refuses a truncated patch (over the 8 MiB output cap), never returning part of it', async () => {
    const r = repo();
    const { ws, exec } = await pushed(r, { capBytes: 200 });
    writeFileSync(join(ws, 'src/app.py'), 'x'.repeat(1000));
    await expect(capturePatch(exec)).rejects.toThrow(/over 8 MiB/);
    await expect(capture(exec)).rejects.toBeInstanceOf(PushError);
  });

  it('says plainly when the sandbox has no baseline (never pushed, or a push cut short)', async () => {
    const { ws, exec } = localWorkspace();
    expect(await hasUnpulled(exec)).toBe(false); // empty: nothing to lose
    mkdirSync(join(ws, 'lost+found'));
    git(ws, 'init', '-q'); // a bare .git (a push cut short after init) holds no work either
    expect(await sandboxState(exec)).toBe('empty');
    writeFileSync(join(ws, 'agent-work.txt'), 'x');
    expect(await hasUnpulled(exec)).toBe(true); // files, but no baseline: never discarded unasked
    await expect(capturePatch(exec)).rejects.toThrow(/no baseline/);
  });

  it('refuses to pull from a push that did not finish, and a later push repairs it', async () => {
    const r = repo();
    const { exec, sent } = localWorkspace();
    const plan = await planPush(r);
    // The first chunk lands, then the connection drops before the baseline commit.
    let n = 0;
    const flaky: typeof exec = async (command, o) => {
      if (++n === 2) throw new Error('connection dropped');
      return exec(command, o);
    };
    await expect(pushTree(flaky, plan)).rejects.toThrow(/connection dropped/);
    expect(sent).toHaveLength(1);
    expect(await sandboxState(exec)).toBe('incomplete');
    expect(await hasUnpulled(exec)).toBe(false); // it emptied the workspace: nothing to lose
    await expect(capturePatch(exec)).rejects.toThrow(/did not finish/);
    await pushTree(exec, plan);
    expect(await sandboxState(exec)).toBe('clean');
  });

  it('reports a failing sandbox command with its stderr', async () => {
    const { exec } = localWorkspace({ without: ['git'] });
    await expect(pushTree(exec, await planPush(repo()))).rejects.toThrow(
      /the push \(part 1 of 1\) failed in the sandbox: .*git: command not found/,
    );
  });
});

describe('applyPatch on a dirty local tree (plan 1c R6c)', () => {
  /** A repo pushed, with the agent's edit of src/app.py and a new file, and the patch for them. */
  async function agentEdit(o: { untracked?: boolean } = {}) {
    const r = repo();
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    if (o.untracked !== false) {
      writeFileSync(join(ws, 'notes.md'), 'agent edit of an untracked file\n');
    }
    return { r, ws, exec, patch: await capturePatch(exec) };
  }

  it('applies beside an uncommitted local edit in a file the patch does not touch', async () => {
    const { r, patch } = await agentEdit();
    writeFileSync(join(r, 'bin/run.sh'), '#!/bin/sh\necho local\n');
    git(r, 'add', 'bin/run.sh'); // staged, even
    const index = git(r, 'ls-files', '--stage');
    await applyPatch(r, patch);
    expect(readFileSync(join(r, 'src/app.py'), 'utf8')).toBe('print(2)\n');
    expect(readFileSync(join(r, 'bin/run.sh'), 'utf8')).toBe('#!/bin/sh\necho local\n');
    expect(git(r, 'ls-files', '--stage')).toBe(index); // the index is untouched
  });

  it('applies to a file that is untracked locally', async () => {
    const { r, patch } = await agentEdit();
    await applyPatch(r, patch);
    expect(readFileSync(join(r, 'notes.md'), 'utf8')).toBe('agent edit of an untracked file\n');
    expect(git(r, 'status', '--porcelain', '--', 'notes.md')).toBe('?? notes.md\n');
  });

  it('refuses a patch over a file with an uncommitted local edit, changing nothing', async () => {
    const { r, patch } = await agentEdit();
    writeFileSync(join(r, 'src/app.py'), 'print("local")\n');
    const before = snapshot(r);
    const index = git(r, 'ls-files', '--stage');
    const err = await applyPatch(r, patch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushError);
    expect((err as Error).message).toMatch(/src\/app\.py/);
    expect((err as Error).message).toMatch(/nothing was changed/);
    expect(snapshot(r)).toEqual(before); // never half-applied: notes.md is untouched too
    expect(git(r, 'ls-files', '--stage')).toBe(index);
  });

  it('falls back to a 3-way merge for a committed local change near the hunk', async () => {
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`);
    const { r, ws, exec } = await (async () => {
      const r = repo();
      writeFileSync(join(r, 'src/m.txt'), lines.join('\n') + '\n');
      git(r, 'add', 'src/m.txt');
      git(r, 'commit', '-qm', 'm');
      return { r, ...(await pushed(r)) };
    })();
    writeFileSync(
      join(ws, 'src/m.txt'),
      lines.map((l, i) => (i === 2 ? 'AGENT' : l)).join('\n') + '\n',
    );
    writeFileSync(join(ws, 'src/added.py'), 'added\n');
    const patch = await capturePatch(exec);
    // Locally, line 5 changed and was committed: the plain apply's context no longer matches.
    writeFileSync(
      join(r, 'src/m.txt'),
      lines.map((l, i) => (i === 4 ? 'LOCAL' : l)).join('\n') + '\n',
    );
    git(r, 'commit', '-qam', 'local');
    const index = git(r, 'ls-files', '--stage');
    await applyPatch(r, patch);
    expect(readFileSync(join(r, 'src/m.txt'), 'utf8')).toContain('AGENT');
    expect(readFileSync(join(r, 'src/m.txt'), 'utf8')).toContain('LOCAL');
    expect(readFileSync(join(r, 'src/added.py'), 'utf8')).toBe('added\n');
    // The merge staged its paths; they are put back, so the index is as it was.
    expect(git(r, 'ls-files', '--stage')).toBe(index);
    expect(git(r, 'status', '--porcelain', '--', 'src')).toBe(' M src/m.txt\n?? src/added.py\n');
  });

  it('refuses a 3-way conflict with nothing applied, staged or marked (review I4)', async () => {
    const r = repo();
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(ws, 'bin/run.sh'), '#!/bin/sh\necho agent\n'); // merges cleanly alone
    writeFileSync(join(ws, 'src/new.py'), 'new\n');
    const patch = await capturePatch(exec);
    writeFileSync(join(r, 'src/app.py'), 'print("local")\n');
    git(r, 'commit', '-qam', 'local');
    git(r, 'config', 'rerere.enabled', 'true'); // a user who has rerere on
    const tree = snapshot(r);
    const index = readFileSync(join(r, '.git/index'));
    // rerere state, which a 3-way apply may record into (when the user has rerere on).
    const rr = () =>
      execFileSync('find', ['.git', '-path', '*rr*', '-print'], { cwd: r }).toString();
    const rrBefore = rr();
    const err = await applyPatch(r, patch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushError);
    expect((err as Error).message).toMatch(
      /conflicts with local commits in src\/app\.py; nothing was applied/,
    );
    expect((err as Error).message).toMatch(/pull -o FILE/);
    expect(snapshot(r)).toEqual(tree); // byte-identical: no markers, no half-applied file
    expect(readFileSync(join(r, '.git/index'))).toEqual(index); // and the index too
    expect(rr()).toBe(rrBefore);
  });

  it('refuses a patch creating a file that exists locally but is ignored, keeping it (review)', async () => {
    const r = repo();
    const { ws, exec } = await pushed(r);
    writeFileSync(join(ws, 'build/out.o'), 'agent'); // ignored locally, absent in the sandbox
    git(ws, 'add', '-f', 'build/out.o'); // (the sandbox's exclude would hide it otherwise)
    writeFileSync(join(ws, '.git/info/exclude'), '');
    const patch = await capturePatch(exec);
    expect(patch.toString()).toContain('build/out.o');
    await expect(applyPatch(r, patch)).rejects.toThrow(/not yet committed \(build\/out\.o\)/);
    expect(readFileSync(join(r, 'build/out.o'), 'utf8')).toBe('ignored\n');
  });

  it('tries no 3-way merge while a touched file has uncommitted changes, naming both kinds', async () => {
    const { r, patch } = await agentEdit(); // touches src/app.py and the untracked notes.md
    writeFileSync(join(r, 'src/app.py'), 'print("local")\n');
    git(r, 'commit', '-qam', 'local'); // committed: alone, a 3-way merge would be tried
    const before = snapshot(r);
    const err = await applyPatch(r, patch).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/not yet committed \(notes\.md\)/);
    expect((err as Error).message).toMatch(/does not apply to src\/app\.py as committed/);
    expect(snapshot(r)).toEqual(before);
    expect(git(r, 'status', '--porcelain', '--', 'src')).toBe('');
  });
});

describe('the repository and its binding (SBX0 §6.1)', () => {
  it('binds the repository, excluding .sbx/ through .git/info/exclude, never .gitignore', async () => {
    const r = repo();
    writeBinding(r, {
      id: SBX,
      controlPlaneUrl: 'https://sbx-api.example.invalid',
      template: 'default',
    });
    expect(JSON.parse(readFileSync(join(r, '.sbx/sandbox.json'), 'utf8'))).toEqual({
      id: SBX,
      controlPlaneUrl: 'https://sbx-api.example.invalid',
      template: 'default',
    });
    // What every later command reads back: the id and the URL (BINDING_URL_RE).
    expect(readBinding(join(r, 'src'))).toEqual({
      id: SBX,
      controlPlaneUrl: 'https://sbx-api.example.invalid',
    });
    expect(readFileSync(join(r, '.git/info/exclude'), 'utf8')).toContain('.sbx/');
    expect(readFileSync(join(r, '.gitignore'), 'utf8')).toBe('build/\n');
    writeBinding(r, {
      id: 'sbx-x',
      controlPlaneUrl: 'https://other.example.invalid',
      template: 't',
    });
    expect(readFileSync(join(r, '.git/info/exclude'), 'utf8').match(/\.sbx\//g)).toHaveLength(1);
    expect(git(r, 'status', '--porcelain')).not.toContain('.sbx'); // excluded
  });

  it('binds a linked worktree through the common info/exclude', async () => {
    const r = repo();
    const wt = join(r, '..', `${r.split('/').pop()}-wt`);
    git(r, 'worktree', 'add', '-q', wt);
    try {
      writeBinding(wt, {
        id: SBX,
        controlPlaneUrl: 'https://sbx-api.example.invalid',
        template: 'default',
      });
      expect(git(wt, 'status', '--porcelain')).not.toContain('.sbx');
      expect(existsSync(join(wt, '.sbx/sandbox.json'))).toBe(true);
      expect(readBinding(wt)?.id).toBe(SBX);
    } finally {
      git(r, 'worktree', 'remove', '--force', wt);
    }
  });

  it('refuses a binding later commands would ignore: a non-ASCII or non-http URL, a bad id', () => {
    const r = repo();
    expect(() => writeBinding(r, { id: SBX, controlPlaneUrl: 'u', template: 't' })).toThrow(
      PushError,
    );
    expect(() =>
      writeBinding(r, { id: '../x', controlPlaneUrl: 'https://a.example.invalid', template: 't' }),
    ).toThrow(PushError);
    expect(existsSync(join(r, '.sbx'))).toBe(false);
    expect(bindingUrl('https://sbx-api.example.invalid/base')).toBe(
      'https://sbx-api.example.invalid/base',
    );
    expect(() => bindingUrl('https://bücher.example.invalid')).toThrow(
      /xn--bcher-kva\.example\.invalid/,
    );
    expect(() => bindingUrl('ftp://a.example.invalid')).toThrow(PushError);
    expect(() => bindingUrl('https://a.example.invalid/\u001b]52;c;x\u0007')).toThrow(PushError);
  });

  it('derives a stable repository id from the origin URL, else the root', async () => {
    const r = repo();
    const bare = await repoId(r);
    expect(bare).toMatch(/^[0-9a-f]{16}$/);
    git(r, 'remote', 'add', 'origin', 'https://example.invalid/team/app.git');
    const withOrigin = await repoId(r);
    expect(withOrigin).toMatch(/^[0-9a-f]{16}$/);
    expect(withOrigin).not.toBe(bare);
    expect(await repoId(r)).toBe(withOrigin);
    const other = repo();
    git(other, 'remote', 'add', 'origin', 'https://example.invalid/team/app.git');
    expect(await repoId(other)).toBe(withOrigin); // the same project in another clone
  });

  it('finds the repository root from a subdirectory, and refuses outside a repository', async () => {
    const r = repo();
    expect(await repoRoot(join(r, 'src'))).toBe(r);
    await expect(repoRoot('/')).rejects.toThrow(/not inside a git repository/);
  });
});
