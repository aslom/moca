import { describe, expect, it } from 'vitest';
import { codexArgs, serverOverride } from '../src/sbx/codex.js';
import { sbxMain } from '../src/sbx/cli.js';
import { fakeCp, SBX, setup, TOKEN } from './helpers/sbx.js';

/** A stand-in for the `codex` child: records its argv, then reports an exit code or an error. */
function fakeCodex(outcome: { code?: number; err?: NodeJS.ErrnoException } = { code: 0 }) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      spawnCodex: (args: string[]) => {
        calls.push(args);
        const handlers: Record<string, (x: never) => void> = {};
        queueMicrotask(() => {
          if (outcome.err) handlers.error?.(outcome.err as never);
          else handlers.exit?.((outcome.code ?? 0) as never);
        });
        return {
          on(e: 'exit' | 'error', cb: (x: never) => void) {
            handlers[e] = cb;
            return this;
          },
        };
      },
    },
  };
}

const mint = () =>
  fakeCp({ [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }) });

describe('mocactl sbx codex (#593)', () => {
  it('registers the sandbox MCP server with -c, disables the shell tool, and writes no config', async () => {
    const { home, env, io } = setup();
    const c = fakeCodex({ code: 0 });
    const code = await sbxMain(['codex', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      codex: c.deps,
    });
    expect(code).toBe(0);
    expect(c.calls).toHaveLength(1);
    // --sandbox is forwarded to the mcp server codex starts, not dropped.
    expect(c.calls[0]).toEqual([
      '-c',
      `mcp_servers.sandbox={command="mocactl",args=["sbx","mcp","--sandbox","${SBX}"]}`,
      '--disable',
      'shell_tool',
    ]);
  });

  it("passes the caller's own arguments through, after ours, so theirs win", async () => {
    const { home, env, io } = setup();
    const c = fakeCodex();
    await sbxMain(
      ['codex', '--sandbox', SBX, '--', '-c', 'model="o3"', 'fix the failing test'],
      env,
      io,
      { home, fetchImpl: mint().fetchImpl, codex: c.deps },
    );
    // Ours first, the user's last: Codex takes the last value for a key.
    expect(c.calls[0]).toEqual([
      '-c',
      serverOverride(SBX),
      '--disable',
      'shell_tool',
      '-c',
      'model="o3"',
      'fix the failing test',
    ]);
  });

  it("exits with codex's own exit code", async () => {
    const { home, env, io } = setup();
    const c = fakeCodex({ code: 3 });
    const code = await sbxMain(['codex', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      codex: c.deps,
    });
    expect(code).toBe(3);
  });

  it('says how to install Codex, and the command to run by hand, when it is not on PATH', async () => {
    const { home, env, io } = setup();
    const err: NodeJS.ErrnoException = new Error('spawn codex ENOENT');
    err.code = 'ENOENT';
    const c = fakeCodex({ err });
    const code = await sbxMain(['codex', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      codex: c.deps,
    });
    expect(code).toBe(1);
    const said = io.errs.join('\n');
    expect(said).toMatch(/codex is not on PATH/);
    expect(said).toMatch(/@openai\/codex/);
    // The escape hatch is the real command, so it can be copied.
    expect(said).toContain(serverOverride(SBX));
  });

  it('refuses --json: a TUI prints none, and a caller parsing stdout would get the TUI', async () => {
    const { home, env, io } = setup();
    const code = await sbxMain(['codex', '--sandbox', SBX, '--json'], env, io, { home });
    expect(code).toBe(2);
  });

  it('builds the override as TOML that codex -c parses, naming the mcp server it starts', () => {
    // With no id, `mocactl sbx mcp` resolves the binding itself: none is baked in.
    expect(serverOverride()).toBe('mcp_servers.sandbox={command="mocactl",args=["sbx","mcp"]}');
    expect(serverOverride()).not.toMatch(/--sandbox/);
    expect(serverOverride(SBX)).toBe(
      `mcp_servers.sandbox={command="mocactl",args=["sbx","mcp","--sandbox","${SBX}"]}`,
    );
    expect(codexArgs([])).toEqual(['-c', serverOverride(), '--disable', 'shell_tool']);
  });
});
