import { spawn } from 'node:child_process';
import { SBX_EXIT, type SbxCtx } from './commands.js';
import { SERVER } from './agent-config.js';

/**
 * `mocactl sbx codex` (#593): Codex CLI pointed at this sandbox for one run.
 *
 * Why a launcher and not agent configuration, as `up` writes for Claude Code and OpenCode: Codex
 * reads no project-local config. A `.codex/config.toml` in the repository is not read at all
 * (verified against codex-cli 0.163.0 and 0.164.0: with the file present and the cwd inside the
 * repository, `codex mcp list` is empty and `codex doctor` reports `config.toml ~/.codex/config.toml`,
 * `MCP servers 0`), and `codex mcp add` has no project scope. Writing `~/.codex/config.toml` would
 * point Codex at this sandbox in EVERY repository on the machine, which `up`'s contract (ordinary
 * files in your working tree, `git status` shows them, `sbx rm` takes them back) cannot express.
 *
 * `-c` carries the server for one invocation instead, and leaves nothing behind.
 *
 * NOT the containment `up` gives Claude Code. `--disable shell_tool` turns off Codex's shell tool,
 * but `unified_exec` runs local commands too and CANNOT be disabled: both `--disable unified_exec`
 * and `-c features.unified_exec=false` are ignored (it stays `stable true`). A real session with
 * `shell_tool` off does reach for the sandbox tools in practice — every tool call was `sandbox.bash`
 * — but that is the model's choice, not a denial. Codex's own sandbox (`sandbox_mode`,
 * `approval_policy`) is the protection that remains, and it is process confinement, not tool denial.
 */

/**
 * The `-c` override that registers this sandbox's MCP server, as TOML (the value `-c` parses).
 *
 * With no `id`, `mocactl sbx mcp` resolves the binding itself, as it does for Claude Code, so the
 * agent follows `up`'s binding rather than a copy of it. An explicit `--sandbox ID` is passed on,
 * so it reaches the server that is actually started rather than being accepted and ignored.
 */
export function serverOverride(id?: string): string {
  const args = id ? `["sbx","mcp","--sandbox","${id}"]` : '["sbx","mcp"]';
  return `mcp_servers.${SERVER}={command="mocactl",args=${args}}`;
}

/**
 * What `codex` is run with: the server, `shell_tool` off, then the caller's own arguments, so a
 * user's `-c` or prompt wins by coming later (Codex takes the last value for a key).
 */
export function codexArgs(rest: readonly string[], id?: string): string[] {
  return ['-c', serverOverride(id), '--disable', 'shell_tool', ...rest];
}

/** What `cmdCodex` needs of a child process: its exit code, or why it could not start. */
export interface CodexChild {
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): unknown;
}

export interface CodexDeps {
  /** Injected in tests; spawns the real `codex` otherwise. */
  spawnCodex?: (args: string[]) => CodexChild;
}

/**
 * Runs `codex` with this sandbox's MCP server, inheriting the terminal (Codex is a TUI), and exits
 * with its code. `sandboxId` is only set when the user named one with `--sandbox`.
 */
export async function cmdCodex(
  c: SbxCtx,
  rest: readonly string[],
  deps: CodexDeps = {},
  sandboxId?: string,
): Promise<number> {
  // `--json` is refused before dispatch: `codex` is in the CLI's NO_JSON set, since a TUI
  // prints none and a caller parsing stdout would get the TUI.
  const args = codexArgs(rest, sandboxId);
  const child: CodexChild = deps.spawnCodex
    ? deps.spawnCodex(args)
    : spawn('codex', args, { stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      c.io.err(
        err.code === 'ENOENT'
          ? 'sbx: codex is not on PATH: install Codex CLI (npm i -g @openai/codex), or run it ' +
              `yourself with: codex -c '${serverOverride(sandboxId)}' --disable shell_tool`
          : `sbx: could not run codex: ${err.message}`,
      );
      resolve(SBX_EXIT.failed);
    });
    child.on('exit', (code: number | null) => resolve(code ?? SBX_EXIT.failed));
  });
}
