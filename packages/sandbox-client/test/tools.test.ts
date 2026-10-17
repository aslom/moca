import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExecMachineryError,
  ExecRefusedError,
  type Exec,
  type ExecResult,
} from '../src/exec-conn.js';
import {
  FILE_TOOL_TIMEOUT_S,
  MAX_BYTES,
  MAX_LINES,
  sandboxTools,
  TOOL_NAMES,
  ToolInputError,
  writeFileCommand,
  type SandboxTool,
} from '../src/tools.js';

const res = (over: Partial<ExecResult> = {}): ExecResult => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  truncated: false,
  ...over,
});

interface Sent {
  command: string;
  stdin?: string;
  timeoutS?: number;
  signal?: AbortSignal;
}

/** A scripted exec: records each command and stdin, answers from a queue. */
function scripted(...answers: (ExecResult | Error)[]) {
  const sent: Sent[] = [];
  const exec: Exec = async (command, o = {}) => {
    sent.push({
      command,
      stdin: o.stdin ? Buffer.from(o.stdin).toString() : undefined,
      timeoutS: o.timeoutS,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const a = answers.shift() ?? res();
    if (a instanceof Error) throw a;
    return a;
  };
  return { exec, sent };
}

/** A REAL shell over a temp dir standing in for /workspace: the tools' commands run for real. */
function local() {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-ws-'));
  let count = 0;
  const exec: Exec = (command, o = {}) =>
    new Promise((resolve) => {
      count++;
      const child = execFile(
        'bash',
        ['-c', command],
        { cwd: dir, encoding: 'buffer', maxBuffer: 64 << 20 },
        (err, stdout, stderr) =>
          resolve({
            stdout,
            stderr,
            exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
            truncated: false,
          }),
      );
      if (o.stdin) child.stdin!.end(Buffer.from(o.stdin));
      else child.stdin!.end();
    });
  const tools = new Map(
    sandboxTools({ info: async () => 'INFO', workspace: dir }).map((t) => [t.name, t]),
  );
  return { dir, exec, tools, count: () => count };
}

const remote = () => new Map(sandboxTools({ info: async () => '' }).map((x) => [x.name, x]));
const t = (tools: Map<string, SandboxTool>, n: string) => tools.get(n)!;
const txt = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('');
const hasRg = !spawnSync('rg', ['--version']).error;

describe('sandbox tools (SBX0 §6.4)', () => {
  it('serves the seven Pi tools plus sandbox_info, in that order', () => {
    expect(sandboxTools({ info: async () => '' }).map((x) => x.name)).toEqual([...TOOL_NAMES]);
  });

  describe('bash', () => {
    it("one Exec, no timeout of its own (the sandbox's cap), stdout then stderr, Pi's exit wording", async () => {
      const s = scripted(
        res({ stdout: Buffer.from('out\n'), stderr: Buffer.from('err\n'), exitCode: 2 }),
      );
      const r = await t(remote(), 'bash').run({ command: 'make test' }, s.exec);
      expect(s.sent).toEqual([{ command: 'make test', stdin: undefined, timeoutS: undefined }]);
      expect(r.isError).toBe(true);
      expect(txt(r)).toBe('out\nerr\n\n\nCommand exited with code 2');
    });

    it('exit 0 is text; no output says so', async () => {
      const s = scripted(res({ stdout: Buffer.from('hi\n') }), res());
      const r = await t(remote(), 'bash').run({ command: 'echo hi' }, s.exec);
      expect(r.isError).toBeUndefined();
      expect(txt(r)).toBe('hi\n');
      expect(txt(await t(remote(), 'bash').run({ command: 'true' }, s.exec))).toBe('(no output)');
    });

    it("honours timeout; a timeout is Pi's 'Command timed out after N seconds'", async () => {
      const s = scripted(res({ exitCode: -1, timedOutS: 5, stdout: Buffer.from('partial\n') }));
      const r = await t(remote(), 'bash').run({ command: 'sleep 999', timeout: 5 }, s.exec);
      expect(s.sent[0]!.timeoutS).toBe(5);
      expect(r.isError).toBe(true);
      expect(txt(r)).toBe('partial\n\n\nCommand timed out after 5 seconds');
    });

    it('a capped timeout says so: on a timeout, and as a note when the command finished', async () => {
      const s = scripted(
        res({ exitCode: -1, timedOutS: 840, capped: true }),
        res({ stdout: Buffer.from('done\n'), capped: true }),
      );
      const timedOut = await t(remote(), 'bash').run({ command: 'x', timeout: 3600 }, s.exec);
      expect(txt(timedOut)).toBe(
        "Command timed out after 840 seconds (timeout capped at 840s, the sandbox token's lifetime)",
      );
      const finished = await t(remote(), 'bash').run({ command: 'x', timeout: 3600 }, s.exec);
      expect(finished.isError).toBeUndefined();
      expect(txt(finished)).toBe(
        "done\n\n\n[timeout capped below the requested 3600s, the sandbox token's lifetime]",
      );
    });

    it('a kill that is not a timeout is an error, not output', async () => {
      const s = scripted(res({ exitCode: -1 }));
      const r = await t(remote(), 'bash').run({ command: 'eat-memory' }, s.exec);
      expect(r.isError).toBe(true);
      expect(txt(r)).toBe('Command was killed (out of memory or a signal)');
    });

    it('tail-truncates long output by lines', async () => {
      const long = Array.from({ length: MAX_LINES + 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const s = scripted(res({ stdout: Buffer.from(`${long}\n`) }));
      const out = txt(await t(remote(), 'bash').run({ command: 'seq' }, s.exec));
      expect(out).toMatch(/^\[Showing the last 2000 of 2050 lines\]\nline 51\n/);
      expect(out.endsWith('line 2050\n')).toBe(true);
      expect(out).not.toContain('line 50\n');
    });

    it('tail-truncates long output by bytes, and a single huge line to its last bytes', async () => {
      const big = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(1023, '.')).join('\n'); // 100 KiB
      const huge = 'x'.repeat(MAX_BYTES * 2);
      const s = scripted(res({ stdout: Buffer.from(big) }), res({ stdout: Buffer.from(huge) }));
      const out = txt(await t(remote(), 'bash').run({ command: 'big' }, s.exec));
      const [note, ...rest] = out.split('\n');
      expect(note).toMatch(/^\[Showing the last (\d+) of 100 lines\]$/);
      expect(Buffer.byteLength(rest.join('\n'))).toBeLessThanOrEqual(MAX_BYTES);
      expect(Number(/last (\d+)/.exec(note!)![1])).toBe(rest.length);
      const one = txt(await t(remote(), 'bash').run({ command: 'huge' }, s.exec));
      expect(one).toMatch(/^\[Showing the last 50\.0KB of line 1 \(100\.0KB\)\]\nx+$/);
      expect(one.split('\n')[1]!.length).toBe(MAX_BYTES);
    });

    it("says when stdout hit the sandbox's 8 MiB cap", async () => {
      const s = scripted(res({ stdout: Buffer.from('a\n'), truncated: true }));
      expect(txt(await t(remote(), 'bash').run({ command: 'x' }, s.exec))).toContain('8 MiB cap');
    });

    it('passes the abort signal through', async () => {
      const s = scripted(res());
      const ac = new AbortController();
      await t(remote(), 'bash').run({ command: 'x' }, s.exec, ac.signal);
      expect(s.sent[0]!.signal).toBe(ac.signal);
    });
  });

  it('refuses malformed input as a tool input error, sending nothing', async () => {
    const tools = remote();
    const s = scripted();
    await expect(t(tools, 'bash').run({}, s.exec)).rejects.toThrow(ToolInputError);
    await expect(t(tools, 'bash').run({}, s.exec)).rejects.toThrow(/command/);
    await expect(t(tools, 'bash').run({ command: 'x', timeout: 0 }, s.exec)).rejects.toThrow(
      /timeout/,
    );
    await expect(t(tools, 'read').run({ path: 'a', offset: -1 }, s.exec)).rejects.toThrow(/offset/);
    await expect(t(tools, 'read').run({ path: 'a', limit: 1.5 }, s.exec)).rejects.toThrow(/limit/);
    await expect(t(tools, 'write').run({ path: 'a' }, s.exec)).rejects.toThrow(/content/);
    await expect(t(tools, 'edit').run({ path: 'a', edits: [] }, s.exec)).rejects.toThrow(
      /at least one/,
    );
    await expect(
      t(tools, 'edit').run({ path: 'a', edits: [{ oldText: '', newText: 'x' }] }, s.exec),
    ).rejects.toThrow(/oldText/);
    await expect(t(tools, 'grep').run({ pattern: 'x', path: 3 }, s.exec)).rejects.toThrow(/path/);
    expect(s.sent).toEqual([]);
  });

  it('a machinery failure or a refusal is thrown, never returned as command output', async () => {
    const tools = remote();
    const calls: [string, Record<string, unknown>][] = [
      ['bash', { command: 'x' }],
      ['read', { path: 'a' }],
      ['write', { path: 'a', content: 'x' }],
      ['edit', { path: 'a', edits: [{ oldText: 'a', newText: 'b' }] }],
      ['grep', { pattern: 'x' }],
      ['find', { pattern: '*' }],
      ['ls', {}],
    ];
    for (const [name, args] of calls) {
      const boom = new ExecMachineryError('sandbox failure: vm boot', 14);
      await expect(t(tools, name).run(args, scripted(boom).exec)).rejects.toBe(boom);
      const no = new ExecRefusedError('denied', 7);
      await expect(t(tools, name).run(args, scripted(no).exec)).rejects.toBe(no);
    }
    // edit's second Exec too: the write's failure is thrown, not a tool result.
    const boom = new ExecMachineryError('sandbox failure: dropped', 14);
    const s = scripted(res({ stdout: Buffer.from('a\n') }), boom);
    await expect(
      t(tools, 'edit').run({ path: 'f', edits: [{ oldText: 'a', newText: 'b' }] }, s.exec),
    ).rejects.toBe(boom);
  });

  it(`the file tools send a short explicit timeout (${FILE_TOOL_TIMEOUT_S} s), so the held token serves them`, async () => {
    const tools = remote();
    const s = scripted(
      res({ stdout: Buffer.from('x\n') }), // read
      res(), // write
      res({ stdout: Buffer.from('a\n') }), // edit: read
      res(), // edit: write
      res({ exitCode: 1 }), // grep
      res({ stdout: Buffer.from('__total:0\n'), exitCode: 1 }), // find
      res(), // ls
    );
    await t(tools, 'read').run({ path: 'f' }, s.exec);
    await t(tools, 'write').run({ path: 'f', content: 'x' }, s.exec);
    await t(tools, 'edit').run({ path: 'f', edits: [{ oldText: 'a', newText: 'b' }] }, s.exec);
    await t(tools, 'grep').run({ pattern: 'x' }, s.exec);
    await t(tools, 'find').run({ pattern: '*' }, s.exec);
    await t(tools, 'ls').run({}, s.exec);
    expect(FILE_TOOL_TIMEOUT_S).toBe(60);
    expect(s.sent.map((x) => x.timeoutS)).toEqual(Array(7).fill(60));
  });

  it('write then read round-trips through a real shell, one Exec each; relative paths land in the workspace', async () => {
    const l = local();
    expect(
      txt(
        await t(l.tools, 'write').run({ path: 'sub/dir/a.txt', content: "it's\nfine\n" }, l.exec),
      ),
    ).toBe(`Successfully wrote 10 bytes to ${l.dir}/sub/dir/a.txt`);
    expect(readFileSync(join(l.dir, 'sub/dir/a.txt'), 'utf8')).toBe("it's\nfine\n");
    expect(txt(await t(l.tools, 'read').run({ path: 'sub/dir/a.txt' }, l.exec))).toBe(
      "it's\nfine\n",
    );
    expect(l.count()).toBe(2);
  });

  it('write: the byte count is UTF-8 bytes; absolute paths are used as given; writeFileCommand is the command', async () => {
    const l = local();
    const abs = join(l.dir, 'abs', 'é.txt');
    expect(txt(await t(l.tools, 'write').run({ path: abs, content: 'é' }, l.exec))).toBe(
      `Successfully wrote 2 bytes to ${abs}`,
    );
    expect(readFileSync(abs, 'utf8')).toBe('é');
    const s = scripted(res({ exitCode: 1, stderr: Buffer.from('Read-only file system') }));
    const r = await t(remote(), 'write').run({ path: "it's/a", content: 'x' }, s.exec);
    expect(s.sent[0]!.command).toBe(writeFileCommand("/workspace/it's/a"));
    expect(writeFileCommand("/workspace/it's/a")).toBe(
      "mkdir -p -- '/workspace/it'\\''s' && cat > '/workspace/it'\\''s/a'",
    );
    expect(s.sent[0]!.stdin).toBe('x');
    expect(r.isError).toBe(true);
    expect(txt(r)).toBe("Could not write /workspace/it's/a: Read-only file system");
  });

  it('read: offset and limit, the continuation note, and an offset past the end', async () => {
    const l = local();
    writeFileSync(
      join(l.dir, 'f'),
      Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n',
    );
    const r = txt(await t(l.tools, 'read').run({ path: 'f', offset: 3, limit: 2 }, l.exec));
    expect(r).toBe('l3\nl4\n\n[Showing lines 3-4 of 10. Use offset=5 to continue.]');
    expect(txt(await t(l.tools, 'read').run({ path: 'f', offset: 9 }, l.exec))).toBe('l9\nl10\n');
    const past = await t(l.tools, 'read').run({ path: 'f', offset: 11 }, l.exec);
    expect(past.isError).toBe(true);
    expect(txt(past)).toBe('Offset 11 is beyond end of file (10 lines total)');
    const missing = await t(l.tools, 'read').run({ path: 'nope' }, l.exec);
    expect(missing.isError).toBe(true);
    expect(txt(missing)).toMatch(/^Could not read .*nope: .*No such file/);
  });

  it('read: an empty file is empty; past its end is an error', async () => {
    const l = local();
    writeFileSync(join(l.dir, 'e'), '');
    expect(txt(await t(l.tools, 'read').run({ path: 'e' }, l.exec))).toBe('');
    expect(txt(await t(l.tools, 'read').run({ path: 'e', offset: 2 }, l.exec))).toBe(
      'Offset 2 is beyond end of file (0 lines total)',
    );
  });

  it('read: head-truncates to 2,000 lines / 50 KB with the continuation note', async () => {
    const tools = remote();
    const lines = Array.from({ length: 2500 }, (_, i) => `r${i + 1}`).join('\n');
    const wide = Array.from({ length: 100 }, () => 'w'.repeat(1023)).join('\n');
    const s = scripted(
      res({ stdout: Buffer.from(lines) }),
      res({ stdout: Buffer.from(wide) }),
      res({ stdout: Buffer.from(`short\n${'z'.repeat(MAX_BYTES + 1)}\n`) }),
    );
    const byLines = txt(await t(tools, 'read').run({ path: 'f' }, s.exec));
    expect(
      byLines.endsWith('r2000\n\n[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]'),
    ).toBe(true);
    const byBytes = txt(await t(tools, 'read').run({ path: 'f' }, s.exec));
    expect(byBytes).toMatch(
      /\n\[Showing lines 1-50 of 100 \(50\.0KB limit\)\. Use offset=51 to continue\.\]$/,
    );
    const longLine = await t(tools, 'read').run({ path: 'f', offset: 2 }, s.exec);
    expect(txt(longLine)).toBe(
      "[Line 2 is 50.0KB, exceeds 50.0KB limit. Use bash: sed -n '2p' /workspace/f | head -c 51200]",
    );
  });

  it('read: a binary file is described, not dumped; an 8 MiB-capped file is refused', async () => {
    const l = local();
    writeFileSync(join(l.dir, 'b'), Buffer.from([0, 1, 2, 3]));
    expect(txt(await t(l.tools, 'read').run({ path: 'b' }, l.exec))).toBe(
      `${l.dir}/b is a binary file (4 bytes); not shown`,
    );
    const s = scripted(res({ stdout: Buffer.from('x'), truncated: true }));
    const big = await t(remote(), 'read').run({ path: 'big' }, s.exec);
    expect(big.isError).toBe(true);
    expect(txt(big)).toMatch(/larger than 8 MiB/);
  });

  it('a file tool that ran out of its timeout says so', async () => {
    const s = scripted(res({ exitCode: -1, timedOutS: 60 }));
    const r = await t(remote(), 'read').run({ path: 'f' }, s.exec);
    expect(r.isError).toBe(true);
    expect(txt(r)).toBe('Could not read /workspace/f: timed out after 60 seconds');
  });

  describe('edit', () => {
    it('two Execs; unique, non-overlapping replacements against the original', async () => {
      const l = local();
      writeFileSync(join(l.dir, 'e.py'), 'a = 1\nb = 2\nc = 3\n');
      const ok = await t(l.tools, 'edit').run(
        {
          path: 'e.py',
          edits: [
            { oldText: 'a = 1', newText: 'a = 10' },
            { oldText: 'c = 3', newText: 'c = 30' },
          ],
        },
        l.exec,
      );
      expect(txt(ok)).toBe(`Successfully replaced 2 block(s) in ${l.dir}/e.py.`);
      expect(readFileSync(join(l.dir, 'e.py'), 'utf8')).toBe('a = 10\nb = 2\nc = 30\n');
      expect(l.count()).toBe(2);
      writeFileSync(join(l.dir, 'd.py'), 'x\nx\n');
      const dup = await t(l.tools, 'edit').run(
        { path: 'd.py', edits: [{ oldText: 'x', newText: 'y' }] },
        l.exec,
      );
      expect(dup.isError).toBe(true);
      expect(txt(dup)).toBe(
        `Found 2 occurrences of the text in ${l.dir}/d.py. The text must be unique. Please provide more context to make it unique.`,
      );
      const absent = await t(l.tools, 'edit').run(
        { path: 'd.py', edits: [{ oldText: 'zzz', newText: 'y' }] },
        l.exec,
      );
      expect(txt(absent)).toBe(
        `Could not find the exact text in ${l.dir}/d.py. The old text must match exactly including all whitespace and newlines.`,
      );
      writeFileSync(join(l.dir, 'o.py'), 'abcdef\n');
      const overlap = await t(l.tools, 'edit').run(
        {
          path: 'o.py',
          edits: [
            { oldText: 'abcd', newText: '1' },
            { oldText: 'cdef', newText: '2' },
          ],
        },
        l.exec,
      );
      expect(txt(overlap)).toBe(
        `edits[0] and edits[1] overlap in ${l.dir}/o.py. Merge them into one edit or target disjoint regions.`,
      );
      expect(readFileSync(join(l.dir, 'o.py'), 'utf8')).toBe('abcdef\n'); // nothing written on refusal
    });

    it('replacement text is taken literally ($& and friends are not patterns)', async () => {
      const l = local();
      writeFileSync(join(l.dir, 'r'), 'price\n');
      await t(l.tools, 'edit').run(
        { path: 'r', edits: [{ oldText: 'price', newText: "$& $1 $$ it's" }] },
        l.exec,
      );
      expect(readFileSync(join(l.dir, 'r'), 'utf8')).toBe("$& $1 $$ it's\n");
    });

    it('a missing file and a no-op edit are errors; nothing is written', async () => {
      const l = local();
      const missing = await t(l.tools, 'edit').run(
        { path: 'nope', edits: [{ oldText: 'a', newText: 'b' }] },
        l.exec,
      );
      expect(missing.isError).toBe(true);
      expect(txt(missing)).toMatch(/^Could not edit file: .*nope\. .*No such file/);
      writeFileSync(join(l.dir, 'same'), 'a\n');
      const same = await t(l.tools, 'edit').run(
        { path: 'same', edits: [{ oldText: 'a', newText: 'a' }] },
        l.exec,
      );
      expect(txt(same)).toMatch(/^No changes made to .*same\./);
      expect(l.count()).toBe(2); // one read each, no write
    });

    it('refuses BEFORE writing when its read came back truncated (no data loss)', async () => {
      const s = scripted(res({ stdout: Buffer.from('a = 1\n'), truncated: true }));
      const r = await t(remote(), 'edit').run(
        { path: 'big.log', edits: [{ oldText: 'a = 1', newText: 'a = 2' }] },
        s.exec,
      );
      expect(r.isError).toBe(true);
      expect(txt(r)).toMatch(
        /^Could not edit file: \/workspace\/big\.log\. It is larger than 8 MiB/,
      );
      expect(s.sent).toHaveLength(1); // the read only: nothing was written back
    });

    it('refuses a file that is not valid UTF-8, which a round-trip would corrupt', async () => {
      const l = local();
      const bytes = Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a]);
      writeFileSync(join(l.dir, 'latin1'), bytes);
      const r = await t(l.tools, 'edit').run(
        { path: 'latin1', edits: [{ oldText: 'a', newText: 'b' }] },
        l.exec,
      );
      expect(r.isError).toBe(true);
      expect(txt(r)).toMatch(/not valid UTF-8/);
      expect(readFileSync(join(l.dir, 'latin1'))).toEqual(bytes);
      expect(l.count()).toBe(1);
    });

    it("sends the original's read, then the write of the new content", async () => {
      const s = scripted(res({ stdout: Buffer.from('a\nb\n') }), res());
      await t(remote(), 'edit').run(
        { path: 'x/f', edits: [{ oldText: 'b', newText: 'B' }] },
        s.exec,
      );
      expect(s.sent.map(({ command, stdin }) => ({ command, stdin }))).toEqual([
        { command: "cat -- '/workspace/x/f'", stdin: undefined },
        { command: "cat > '/workspace/x/f'", stdin: 'a\nB\n' },
      ]);
    });
  });

  it('ls: one Exec, directories marked, sorted case-insensitively, empty directory, missing path, limit', async () => {
    const l = local();
    mkdirSync(join(l.dir, 'src'));
    writeFileSync(join(l.dir, 'README'), 'x');
    writeFileSync(join(l.dir, '.env'), 'x');
    writeFileSync(join(l.dir, 'b'), 'x');
    expect(txt(await t(l.tools, 'ls').run({}, l.exec))).toBe('.env\nb\nREADME\nsrc/');
    expect(txt(await t(l.tools, 'ls').run({ path: 'src' }, l.exec))).toBe('(empty directory)');
    const missing = await t(l.tools, 'ls').run({ path: 'nope' }, l.exec);
    expect(missing.isError).toBe(true);
    expect(txt(missing)).toBe(`Path not found or not a directory: ${l.dir}/nope`);
    expect(txt(await t(l.tools, 'ls').run({ limit: 2 }, l.exec))).toBe(
      '.env\nb\n\n[2 of 4 entries shown. Use limit to see more.]',
    );
    expect(l.count()).toBe(4);
  });

  describe('grep', () => {
    it('one Exec with rg flags (-H included); workspace-relative paths; no matches; rg errors', async () => {
      const tools = remote();
      const s = scripted(
        res({ stdout: Buffer.from('/workspace/src/a.ts:3:const x = 1\n') }),
        res({ exitCode: 1 }),
        res({ exitCode: 2, stderr: Buffer.from('regex parse error') }),
      );
      const hit = await t(tools, 'grep').run(
        { pattern: 'const x', glob: '*.ts', ignoreCase: true, literal: true, context: 1 },
        s.exec,
      );
      expect(txt(hit)).toBe('src/a.ts:3:const x = 1');
      expect(s.sent[0]!.command).toMatch(
        /rg -n -H --no-heading --color=never --hidden --glob '!\.git' -i -F -C 1 --glob '\*\.ts' -e 'const x' -- '\/workspace'/,
      );
      expect(txt(await t(tools, 'grep').run({ pattern: 'q' }, s.exec))).toBe('No matches found');
      const bad = await t(tools, 'grep').run({ pattern: '(' }, s.exec);
      expect(bad.isError).toBe(true);
      expect(txt(bad)).toBe('regex parse error');
      expect(s.sent).toHaveLength(3);
    });

    it('a single-file grep keeps the file name (-H)', async () => {
      const s = scripted(res({ stdout: Buffer.from('/workspace/lib/a.py:7:def f():\n') }));
      const r = await t(remote(), 'grep').run({ pattern: 'def', path: 'lib/a.py' }, s.exec);
      expect(s.sent[0]!.command).toContain(' -H ');
      expect(s.sent[0]!.command).toContain("-- '/workspace/lib/a.py'");
      expect(txt(r)).toBe('lib/a.py:7:def f():');
    });

    it('caps lines at the limit, and long lines at 500 chars', async () => {
      const many = Array.from({ length: 4 }, (_, i) => `/workspace/a:${i + 1}:m`).join('\n');
      const s = scripted(
        res({ stdout: Buffer.from(many) }),
        res({ stdout: Buffer.from(`/workspace/a:1:${'y'.repeat(600)}\n`) }),
      );
      const r = txt(await t(remote(), 'grep').run({ pattern: 'm', limit: 2 }, s.exec));
      // One line past the cap is fetched, to tell "exactly limit" from "more than limit".
      expect(s.sent[0]!.command).toContain('head -n 3 ');
      expect(r).toBe(
        'a:1:m\na:2:m\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]',
      );
      const long = txt(await t(remote(), 'grep').run({ pattern: 'y' }, s.exec));
      expect(long).toBe(
        `a:1:${'y'.repeat(496)}... [truncated]\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]`,
      );
    });

    it.skipIf(!hasRg)('against a real rg: a single file, a directory, and no match', async () => {
      const l = local();
      mkdirSync(join(l.dir, 'src'));
      writeFileSync(join(l.dir, 'src', 'a.ts'), 'const x = 1\nconst y = 2\n');
      writeFileSync(join(l.dir, 'notes.md'), 'nothing\n');
      expect(txt(await t(l.tools, 'grep').run({ pattern: 'y =', path: 'src/a.ts' }, l.exec))).toBe(
        'src/a.ts:2:const y = 2',
      );
      expect(txt(await t(l.tools, 'grep').run({ pattern: 'const', glob: '*.ts' }, l.exec))).toBe(
        'src/a.ts:1:const x = 1\nsrc/a.ts:2:const y = 2',
      );
      expect(txt(await t(l.tools, 'grep').run({ pattern: 'zzz' }, l.exec))).toBe(
        'No matches found',
      );
      expect(l.count()).toBe(3);
    });
  });

  describe('find', () => {
    it('one Exec; sorted relative paths; the limit note; none found; a missing path', async () => {
      const tools = remote();
      const s = scripted(
        res({ stdout: Buffer.from('__total:3\na.ts\nb.ts\n') }),
        res({ exitCode: 1, stdout: Buffer.from('__total:0\n') }),
        res({
          exitCode: 3,
          stderr: Buffer.from('bash: line 1: cd: /workspace/x: No such file or directory\n'),
        }),
      );
      const r = txt(await t(tools, 'find').run({ pattern: '*.ts', limit: 2 }, s.exec));
      expect(r).toBe('a.ts\nb.ts\n\n[2 of 3 results shown. Use limit to see more.]');
      expect(s.sent[0]!.command).toMatch(
        /^cd -- '\/workspace' \|\| exit 3; .*rg --files --hidden --glob '!\.git' --glob '\*\.ts'/,
      );
      expect(s.sent[0]!.command).toContain('| head -n 2;');
      expect(txt(await t(tools, 'find').run({ pattern: '*.rs' }, s.exec))).toBe(
        'No files found matching pattern',
      );
      const missing = await t(tools, 'find').run({ pattern: '*', path: 'x' }, s.exec);
      expect(missing.isError).toBe(true);
      expect(txt(missing)).toBe('Path not found or not a directory: /workspace/x');
    });

    it.skipIf(!hasRg)(
      'against a real rg: relative, sorted, .git excluded, hidden included',
      async () => {
        const l = local();
        mkdirSync(join(l.dir, '.git'));
        mkdirSync(join(l.dir, 'src'));
        writeFileSync(join(l.dir, '.git', 'x.ts'), '');
        writeFileSync(join(l.dir, 'src', 'b.ts'), '');
        writeFileSync(join(l.dir, '.a.ts'), '');
        writeFileSync(join(l.dir, 'c.md'), '');
        expect(txt(await t(l.tools, 'find').run({ pattern: '*.ts' }, l.exec))).toBe(
          '.a.ts\nsrc/b.ts',
        );
        expect(txt(await t(l.tools, 'find').run({ pattern: '*.ts', path: 'src' }, l.exec))).toBe(
          'b.ts',
        );
        expect(txt(await t(l.tools, 'find').run({ pattern: '*.rs' }, l.exec))).toBe(
          'No files found matching pattern',
        );
        expect((await t(l.tools, 'find').run({ pattern: '*', path: 'nope' }, l.exec)).isError).toBe(
          true,
        );
      },
    );
  });

  it('sandbox_info: no Exec, the host text', async () => {
    const tools = new Map(
      sandboxTools({ info: async () => 'template default, expires …' }).map((x) => [x.name, x]),
    );
    const s = scripted();
    expect(txt(await t(tools, 'sandbox_info').run({}, s.exec))).toBe('template default, expires …');
    expect(s.sent).toEqual([]);
  });
});
