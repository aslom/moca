import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_DENY,
  ConfigConflict,
  MARK_BEGIN,
  MARK_END,
  OPENCODE_OFF,
  RULES,
  checkAgentConfig,
  removeAgentConfig,
  takeBackAgentConfig,
  writeAgentConfig,
} from '../src/sbx/agent-config.js';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cfg-')));
  made.push(d);
  mkdirSync(join(d, '.git'));
  return d;
};
const json = (d: string, f: string) => JSON.parse(readFileSync(join(d, f), 'utf8'));
const text = (d: string, f: string) => readFileSync(join(d, f), 'utf8');
const FILES = ['.mcp.json', '.claude/settings.json', 'opencode.json', 'CLAUDE.md', 'AGENTS.md'];
const conflictOf = (fn: () => unknown): ConfigConflict => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigConflict) return e;
    throw e;
  }
  throw new Error('no ConfigConflict');
};

describe('agent configuration (SBX0 §6.3)', () => {
  it('configures both agents in an empty repository', () => {
    const d = dir();
    expect(writeAgentConfig(d).changed.sort()).toEqual([...FILES].sort());
    expect(json(d, '.mcp.json').mcpServers.sandbox).toEqual({
      command: 'mocactl',
      args: ['sbx', 'mcp'],
    });
    const s = json(d, '.claude/settings.json');
    expect(s.permissions.allow).toEqual(['mcp__sandbox__*']);
    expect(s.permissions.deny).toEqual([...CLAUDE_DENY]);
    // R7: Claude Code loads the project server without asking.
    expect(s.enabledMcpjsonServers).toEqual(['sandbox']);
    const o = json(d, 'opencode.json');
    expect(o.mcp.sandbox).toEqual({
      type: 'local',
      command: ['mocactl', 'sbx', 'mcp'],
      enabled: true,
    });
    for (const t of OPENCODE_OFF) expect(o.tools[t]).toBe(false);
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const md = text(d, f);
      expect(md).toBe(`${MARK_BEGIN}\n${RULES}\n${MARK_END}\n`);
      expect(md).toMatch(/fresh VM/);
    }
    expect(checkAgentConfig(d)).toEqual([]);
  });

  it('holds the spec §6.3 lists verbatim', () => {
    expect(CLAUDE_DENY).toEqual([
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Task',
      'EnterWorktree',
      'ExitWorktree',
      'Workflow',
    ]);
    expect(OPENCODE_OFF).toEqual([
      'bash',
      'read',
      'edit',
      'write',
      'patch',
      'glob',
      'grep',
      'list',
      'lsp',
      'webfetch',
      'websearch',
      'task',
      // The newer name for patch in current OpenCode (review round 2).
      'apply_patch',
    ]);
    for (const s of [
      'remote sandbox at `/workspace`',
      'fresh VM',
      'no process survives',
      'persist',
      'no network',
      'one at a time',
      'batch',
    ]) {
      expect(RULES).toContain(s);
    }
  });

  it('keeps everything the developer had: other servers, allow entries, and their CLAUDE.md byte for byte', () => {
    const d = dir();
    writeFileSync(
      join(d, '.mcp.json'),
      JSON.stringify({
        mcpServers: { github: { type: 'http', url: 'https://x.example.invalid' } },
        other: 1,
      }),
    );
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['mcp__github__*'], deny: ['Bash'] }, model: 'x' }),
    );
    const mine = '# My project\n\nRun `make` to build.\n';
    writeFileSync(join(d, 'CLAUDE.md'), mine);
    writeAgentConfig(d);
    expect(json(d, '.mcp.json')).toMatchObject({
      other: 1,
      mcpServers: { github: { url: 'https://x.example.invalid' } },
    });
    expect(Object.keys(json(d, '.mcp.json'))).toEqual(['mcpServers', 'other']);
    expect(Object.keys(json(d, '.mcp.json').mcpServers)).toEqual(['github', 'sandbox']);
    const s = json(d, '.claude/settings.json');
    expect(s.model).toBe('x');
    expect(Object.keys(s)).toEqual(['permissions', 'model', 'enabledMcpjsonServers']);
    expect(s.permissions.allow).toEqual(['mcp__github__*', 'mcp__sandbox__*']);
    expect(s.permissions.deny.filter((x: string) => x === 'Bash')).toHaveLength(1);
    expect(s.permissions.deny).toEqual(['Bash', ...CLAUDE_DENY.filter((t) => t !== 'Bash')]);
    const md = text(d, 'CLAUDE.md');
    expect(md.startsWith(mine)).toBe(true);
    expect(md.slice(mine.length)).toMatch(new RegExp(`^\\n${MARK_BEGIN}[\\s\\S]*${MARK_END}\\n$`));
  });

  it("keeps the file's own formatting: indentation, comments in opencode.json, line endings", () => {
    const d = dir();
    const mcp =
      '{\n\t"mcpServers": {\n\t\t"github": {\n\t\t\t"url": "https://x.example.invalid"\n\t\t}\n\t}\n}\n';
    writeFileSync(join(d, '.mcp.json'), mcp);
    // OpenCode reads JSONC: comments and trailing commas are kept.
    writeFileSync(
      join(d, 'opencode.json'),
      '{\n    // my model\n    "model": "anthropic/x",\n    "tools": { "bash": false, },\n}\n',
    );
    writeFileSync(join(d, 'AGENTS.md'), '# Agents\r\n\r\nUse care.\r\n');
    writeAgentConfig(d);
    const m = text(d, '.mcp.json');
    expect(m.startsWith('{\n\t"mcpServers": {\n\t\t"github": {\n\t\t\t"url"')).toBe(true);
    expect(m).toContain('\n\t\t"sandbox": {\n\t\t\t"command": "mocactl",');
    const o = text(d, 'opencode.json');
    expect(o).toContain('    // my model\n    "model": "anthropic/x",');
    expect(o).toMatch(/"read": false/);
    const a = text(d, 'AGENTS.md');
    expect(a.startsWith('# Agents\r\n\r\nUse care.\r\n\r\n<!-- sbx:begin -->\r\n')).toBe(true);
    expect(a.endsWith(`${MARK_END}\r\n`)).toBe(true);
    expect(a.replace(/\r\n/g, '')).not.toContain('\n');
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, '.mcp.json')).toBe(mcp);
    expect(text(d, 'AGENTS.md')).toBe('# Agents\r\n\r\nUse care.\r\n');
    expect(text(d, 'opencode.json')).toContain('// my model');
  });

  it('is idempotent: a second run changes nothing', () => {
    const d = dir();
    writeAgentConfig(d);
    const snap = FILES.map((f) => text(d, f));
    const manifest = text(d, '.sbx/agent-config.json');
    expect(writeAgentConfig(d).changed).toEqual([]);
    expect(writeAgentConfig(d, { dryRun: true }).changed).toEqual([]);
    expect(FILES.map((f) => text(d, f))).toEqual(snap);
    expect(text(d, '.sbx/agent-config.json')).toBe(manifest);
  });

  it('a dry run reports what it would change and writes nothing', () => {
    const d = dir();
    writeFileSync(join(d, 'CLAUDE.md'), '# Mine\n');
    expect(writeAgentConfig(d, { dryRun: true }).changed.sort()).toEqual([...FILES].sort());
    expect(text(d, 'CLAUDE.md')).toBe('# Mine\n');
    for (const f of [...FILES.filter((f) => f !== 'CLAUDE.md'), '.sbx', '.claude']) {
      expect(existsSync(join(d, f)), f).toBe(false);
    }
  });

  it('replaces only the marked block when the rules change, and rm puts the old block back', () => {
    const d = dir();
    const before = `top\n${MARK_BEGIN}\nold rules\n${MARK_END}\nbottom\n`;
    writeFileSync(join(d, 'AGENTS.md'), before);
    writeAgentConfig(d);
    const md = text(d, 'AGENTS.md');
    expect(md.startsWith('top\n')).toBe(true);
    expect(md.endsWith(`${MARK_END}\nbottom\n`)).toBe(true);
    expect(md).not.toContain('old rules');
    removeAgentConfig(d);
    expect(text(d, 'AGENTS.md')).toBe(before);
  });

  it.each([
    [
      '.mcp.json',
      JSON.stringify({ mcpServers: { sandbox: { command: 'other' } } }),
      'mcpServers.sandbox',
    ],
    ['.mcp.json', JSON.stringify({ mcpServers: ['x'] }), 'mcpServers'],
    ['.mcp.json', '[]', '.mcp.json'],
    [
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash'] } }),
      'permissions.allow',
    ],
    [
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }),
      'permissions.allow',
    ],
    [
      '.claude/settings.json',
      JSON.stringify({ permissions: { deny: 'Bash' } }),
      'permissions.deny',
    ],
    [
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['sandbox'] }),
      'disabledMcpjsonServers',
    ],
    [
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['sandbox'] }),
      'disabledMcpjsonServers',
    ],
    // Claude Code reads plain JSON: a comment is refused, not rewritten.
    ['.claude/settings.json', '{ // mine\n "model": "x" }', '.claude/settings.json'],
    ['opencode.json', JSON.stringify({ tools: { bash: true } }), 'tools.bash'],
    ['opencode.json', JSON.stringify({ tools: { lsp: 'yes' } }), 'tools.lsp'],
    [
      'opencode.json',
      JSON.stringify({ mcp: { sandbox: { type: 'remote', url: 'https://x.example.invalid' } } }),
      'mcp.sandbox',
    ],
    [
      'opencode.json',
      JSON.stringify({
        mcp: { sandbox: { type: 'local', command: ['mocactl', 'sbx', 'mcp'], enabled: false } },
      }),
      'mcp.sandbox',
    ],
    ['opencode.json', '{ not json', 'opencode.json'],
    ['CLAUDE.md', `a\n${MARK_BEGIN}\nb\n`, 'markers'],
    ['AGENTS.md', `${MARK_BEGIN}\n${MARK_END}\n${MARK_BEGIN}\n${MARK_END}\n`, 'markers'],
  ])('stops on a conflict in %s (%s), naming %s, and writes nothing', (file, body, key) => {
    const d = dir();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, file), body);
    for (const dryRun of [true, false]) {
      const err = conflictOf(() => writeAgentConfig(d, { dryRun }));
      expect(err.file).toBe(file);
      expect(err.message).toContain(file);
      expect(err.message).toContain(key);
      expect(err.message).toMatch(/--no-agent-config/);
    }
    expect(text(d, file)).toBe(body);
    for (const f of FILES.filter((f) => f !== file)) expect(existsSync(join(d, f)), f).toBe(false);
    expect(existsSync(join(d, '.sbx'))).toBe(false);
  });

  // Review I2: OpenCode's agent config overrides the global `tools`, and `permission` is the
  // newer key (tools is deprecated into it); either can switch a local tool back on.
  it.each([
    [{ agent: { build: { tools: { bash: true } } } }, 'agent.build.tools.bash'],
    [{ agent: { plan: { tools: { 'web*': true } } } }, 'agent.plan.tools.web*'],
    [{ permission: { bash: 'allow' } }, 'permission.bash'],
    [{ permission: { read: 'ask' } }, 'permission.read'],
    // `edit` gates write and patch too.
    [{ permission: { edit: { '*': 'deny', 'docs/*': 'allow' } } }, 'permission.edit'],
    [{ permission: { '*': 'ask' } }, 'permission.*'],
    [{ permission: 'allow' }, 'permission'],
    [
      { agent: { build: { permission: { webfetch: 'allow' } } } },
      'agent.build.permission.webfetch',
    ],
    [{ agent: { build: { permission: 'ask' } } }, 'agent.build.permission'],
  ])('refuses an OpenCode override that re-enables a local tool: %j names %s', (body, key) => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(body));
    const err = conflictOf(() => writeAgentConfig(d, { dryRun: true }));
    expect(err.file).toBe('opencode.json');
    expect(err.key).toBe(key);
    expect(err.message).toContain(`opencode.json: ${key}`);
  });

  it.each(['{ }\n', '{\n}\n', '{\n  "tools": { }\n}\n', '{\n  "mcp": {\n  }\n}\n'])(
    'an empty object keeps its inside through up and rm (review round 2): %j',
    (oc) => {
      const d = dir();
      writeFileSync(join(d, 'opencode.json'), oc);
      mkdirSync(join(d, '.claude'));
      writeFileSync(join(d, '.claude/settings.json'), '{\n  "permissions": {\n  }\n}\n');
      writeAgentConfig(d);
      expect(checkAgentConfig(d)).toEqual([]);
      removeAgentConfig(d);
      expect(text(d, 'opencode.json')).toBe(oc);
      expect(text(d, '.claude/settings.json')).toBe('{\n  "permissions": {\n  }\n}\n');
    },
  );

  it.each([
    '{"model": "x" /* a\n  b */}',
    '{\n  "model": "x" /* c */ }\n',
    '{"tools":{"skill":true /* a\n b */ }}',
    '{ "skill": true /* a\n */ }',
    '{\n  "tools": {\n    "skill": true /* a\n    b */ }\n}\n',
  ])('keeps a comment before a closing bracket, through up and rm (review round 3): %j', (oc) => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), oc);
    writeAgentConfig(d);
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, 'opencode.json')).toBe(oc);
  });

  it('puts new members after a multi-line block comment, not inside it (review round 2)', () => {
    const d = dir();
    const oc = '{\n  "model": "x" /* a\n  b */\n}\n';
    writeFileSync(join(d, 'opencode.json'), oc);
    writeAgentConfig(d);
    expect(checkAgentConfig(d)).toEqual([]);
    expect(text(d, 'opencode.json').startsWith('{\n  "model": "x", /* a\n  b */\n')).toBe(true);
    removeAgentConfig(d);
    expect(text(d, 'opencode.json')).toBe(oc);
  });

  it.each([
    [{ tools: { apply_patch: true } }, 'tools.apply_patch'],
    [{ agent: { build: { tools: { apply_patch: true } } } }, 'agent.build.tools.apply_patch'],
    [{ permission: { apply_patch: 'allow' } }, 'permission.apply_patch'],
  ])('refuses apply_patch switched on: %j names %s', (body, key) => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(body));
    expect(conflictOf(() => writeAgentConfig(d, { dryRun: true })).key).toBe(key);
    // And doctor finds it in a configured repository.
    const e = dir();
    writeAgentConfig(e);
    const o = json(e, 'opencode.json');
    Object.assign(o, body);
    if ('tools' in body) o.tools = { ...o.tools, ...body.tools };
    writeFileSync(join(e, 'opencode.json'), JSON.stringify(o));
    expect(checkAgentConfig(e).join('\n')).toMatch(/OpenCode.*apply_patch/);
  });

  it('accepts OpenCode overrides that keep the local tools off', () => {
    const d = dir();
    const body = {
      permission: { bash: 'deny', edit: { '*': 'deny' }, skill: 'allow', sandbox_bash: 'allow' },
      agent: {
        build: { tools: { bash: false, mymcp_x: true }, permission: { question: 'allow' } },
      },
    };
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(body));
    writeAgentConfig(d);
    expect(checkAgentConfig(d)).toEqual([]);
  });

  it.each([
    [
      '.mcp.json',
      '{"mcpServers":{"sandbox":{"command":"evil"},"sandbox":{"command":"mocactl","args":["sbx","mcp"]}}}',
      'mcpServers.sandbox',
      /duplicate key/,
    ],
    [
      '.mcp.json',
      '{\n  "mcpServers": {"a": {"command":"a"}},\n  "mcpServers": {}\n}\n',
      'mcpServers',
      /duplicate key/,
    ],
    [
      'opencode.json',
      '{\n  "tools": {"bash": true},\n  // again\n  "tools": {"read": false}\n}\n',
      'tools',
      /duplicate key/,
    ],
    ['.mcp.json', '\ufeff{"mcpServers":{}}\n', '.mcp.json', /starts with a byte-order mark/],
    ['opencode.json', '\ufeff{}', 'opencode.json', /starts with a byte-order mark/],
    ['.mcp.json', '', '.mcp.json', /is empty/],
    ['.mcp.json', '  \n', '.mcp.json', /is empty/],
    ['.mcp.json', '{"a":1,}', '.mcp.json', /is not valid JSON/],
  ])('refuses %s %j, naming %s and saying why', (file, body, key, why) => {
    const d = dir();
    writeFileSync(join(d, file), body);
    const err = conflictOf(() => writeAgentConfig(d, { dryRun: true }));
    expect(err.file).toBe(file);
    expect(err.key).toBe(key);
    expect(err.message).toMatch(why);
    expect(err.message).not.toMatch(/reads no comments/);
    expect(checkAgentConfig(d).join('\n')).toMatch(why);
  });

  it('says a comment is why Claude Code would refuse its file', () => {
    const d = dir();
    writeFileSync(join(d, '.mcp.json'), '{ // mine\n}');
    expect(conflictOf(() => writeAgentConfig(d)).message).toMatch(
      /comments, which Claude Code does not read/,
    );
  });

  it('accepts a sandbox server that is already the same one, and never removes it', () => {
    const d = dir();
    const mine = {
      mcpServers: { sandbox: { type: 'stdio', command: 'mocactl', args: ['sbx', 'mcp'], env: {} } },
    };
    writeFileSync(join(d, '.mcp.json'), JSON.stringify(mine, null, 2) + '\n');
    writeAgentConfig(d);
    expect(json(d, '.mcp.json')).toEqual(mine);
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(json(d, '.mcp.json')).toEqual(mine);
  });

  it('removes exactly what it added, and deletes the files it created', () => {
    const d = dir();
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['mcp__github__*'], deny: ['Bash'] } }),
    );
    writeFileSync(join(d, 'CLAUDE.md'), '# Mine\n');
    writeAgentConfig(d);
    expect(removeAgentConfig(d).sort()).toEqual([...FILES].sort());
    expect(json(d, '.claude/settings.json')).toEqual({
      permissions: { allow: ['mcp__github__*'], deny: ['Bash'] },
    });
    expect(text(d, 'CLAUDE.md')).toBe('# Mine\n');
    for (const f of ['.mcp.json', 'opencode.json', 'AGENTS.md']) {
      expect(existsSync(join(d, f)), f).toBe(false);
    }
    expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(false);
    expect(removeAgentConfig(d)).toEqual([]);
  });

  it('removes the .claude directory it created, and enabledMcpjsonServers with it', () => {
    const d = dir();
    writeAgentConfig(d);
    removeAgentConfig(d);
    for (const f of [...FILES, '.claude']) expect(existsSync(join(d, f)), f).toBe(false);
  });

  it('removal keeps what the developer added after sbx up, and the values they had', () => {
    const d = dir();
    writeFileSync(join(d, 'settings.json'), ''); // a decoy at the root: never touched
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['github'] }),
    );
    writeAgentConfig(d);
    const s = json(d, '.claude/settings.json');
    expect(s.enabledMcpjsonServers).toEqual(['github', 'sandbox']);
    s.permissions.allow.push('mcp__later__*');
    s.later = true;
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2));
    const m = json(d, '.mcp.json');
    m.mcpServers.later = { command: 'later' };
    writeFileSync(join(d, '.mcp.json'), JSON.stringify(m, null, 2));
    removeAgentConfig(d);
    expect(json(d, '.claude/settings.json')).toEqual({
      enabledMcpjsonServers: ['github'],
      permissions: { allow: ['mcp__later__*'] },
      later: true,
    });
    expect(json(d, '.mcp.json')).toEqual({ mcpServers: { later: { command: 'later' } } });
    expect(text(d, 'settings.json')).toBe('');
  });

  it('writes atomically and keeps the file mode', () => {
    const d = dir();
    writeFileSync(join(d, '.mcp.json'), '{}\n');
    chmodSync(join(d, '.mcp.json'), 0o600);
    writeFileSync(join(d, 'CLAUDE.md'), '# x\n');
    chmodSync(join(d, 'CLAUDE.md'), 0o640);
    writeAgentConfig(d);
    expect(statSync(join(d, '.mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'CLAUDE.md')).mode & 0o777).toBe(0o640);
    expect(statSync(join(d, '.sbx/agent-config.json')).mode & 0o777).toBe(0o600);
    removeAgentConfig(d);
    expect(statSync(join(d, '.mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'CLAUDE.md')).mode & 0o777).toBe(0o640);
  });

  it('writes through a CLAUDE.md that links to AGENTS.md, once, and keeps the link', () => {
    const d = dir();
    writeFileSync(join(d, 'AGENTS.md'), '# Shared\n');
    symlinkSync('AGENTS.md', join(d, 'CLAUDE.md'));
    expect(writeAgentConfig(d).changed.filter((f) => f.endsWith('.md'))).toEqual(['AGENTS.md']);
    const md = text(d, 'AGENTS.md');
    expect(md.split(MARK_BEGIN)).toHaveLength(2);
    expect(md.startsWith('# Shared\n\n')).toBe(true);
    expect(statSync(join(d, 'CLAUDE.md')).isFile()).toBe(true);
    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toBe(md);
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, 'AGENTS.md')).toBe('# Shared\n');
    expect(realpathSync(join(d, 'CLAUDE.md'))).toBe(join(d, 'AGENTS.md'));
  });

  it('refuses a file that links outside the repository', () => {
    const d = dir();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-out-')));
    made.push(outside);
    writeFileSync(join(outside, 'CLAUDE.md'), '# dotfiles\n');
    symlinkSync(join(outside, 'CLAUDE.md'), join(d, 'CLAUDE.md'));
    const err = conflictOf(() => writeAgentConfig(d));
    expect(err.file).toBe('CLAUDE.md');
    expect(err.message).toMatch(/outside the repository/);
    expect(text(outside, 'CLAUDE.md')).toBe('# dotfiles\n');
  });

  it('uses opencode.jsonc when that is the file the repository has; refuses both', () => {
    const d = dir();
    writeFileSync(join(d, 'opencode.jsonc'), '{\n  // mine\n  "model": "x"\n}\n');
    writeAgentConfig(d);
    expect(existsSync(join(d, 'opencode.json'))).toBe(false);
    expect(text(d, 'opencode.jsonc')).toContain('"sandbox"');
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, 'opencode.jsonc')).toBe('{\n  // mine\n  "model": "x"\n}\n');
    writeFileSync(join(d, 'opencode.json'), '{}');
    const err = conflictOf(() => writeAgentConfig(d, { dryRun: true }));
    expect(err.message).toMatch(/opencode\.json.*opencode\.jsonc|opencode\.jsonc.*opencode\.json/);
  });

  it('a later run records only what it added: rm still takes back the first run too', () => {
    const d = dir();
    writeAgentConfig(d);
    const s = json(d, '.claude/settings.json');
    s.permissions.deny = s.permissions.deny.filter((t: string) => t !== 'Grep');
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
    expect(writeAgentConfig(d).changed).toEqual(['.claude/settings.json']);
    removeAgentConfig(d);
    for (const f of [...FILES, '.claude']) expect(existsSync(join(d, f)), f).toBe(false);
  });

  it.each([
    ['corrupt', '{ broken'],
    ['of an unknown version', JSON.stringify({ version: 2, files: [] })],
    // Review round 3: every entry's shape is checked.
    ['missing a list', JSON.stringify({ version: 1, files: [], dirs: [], json: [] })],
    [
      'with a list that is not one',
      JSON.stringify({ version: 1, files: {}, dirs: [], json: [], markdown: [] }),
    ],
    [
      'with a file that is not a string',
      JSON.stringify({ version: 1, files: [1], dirs: [], json: [], markdown: [] }),
    ],
    [
      'with an inner that is not a string',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'inner', path: ['mcp'], inner: 7 }],
        markdown: [],
      }),
    ],
    [
      'with an unknown op',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'drop', path: [] }],
        markdown: [],
      }),
    ],
    [
      'with a path that is not a list of keys',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'key', path: 'mcp', value: 1 }],
        markdown: [],
      }),
    ],
    [
      'with a key and no value',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'key', path: ['mcp'] }],
        markdown: [],
      }),
    ],
    [
      'with a Markdown entry of an unknown mode',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [],
        markdown: [{ file: 'CLAUDE.md', mode: 'moved' }],
      }),
    ],
    [
      'with a replaced entry and no previous block',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [],
        markdown: [{ file: 'CLAUDE.md', mode: 'replaced' }],
      }),
    ],
    [
      'with a file outside the repository',
      JSON.stringify({ version: 1, files: ['../x.json'], dirs: [], json: [], markdown: [] }),
    ],
  ])('a record that is %s is kept, with a warning, and nothing is removed', (_n, body) => {
    const d = dir();
    writeAgentConfig(d);
    writeFileSync(join(d, '.sbx/agent-config.json'), body);
    const r = takeBackAgentConfig(d);
    expect(r.removed).toEqual([]);
    expect(r.recordKept).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/\.sbx\/agent-config\.json .*kept/);
    expect(text(d, '.sbx/agent-config.json')).toBe(body);
    expect(existsSync(join(d, '.mcp.json'))).toBe(true);
    // And up will not write over it, orphaning what it lists.
    expect(conflictOf(() => writeAgentConfig(d, { dryRun: true })).file).toBe(
      '.sbx/agent-config.json',
    );
  });

  it('names a Markdown file whose markers were broken by hand as skipped, leaving it alone', () => {
    const d = dir();
    writeFileSync(join(d, 'CLAUDE.md'), '# Mine\n');
    writeAgentConfig(d);
    const broken = text(d, 'CLAUDE.md').replace(MARK_END, '');
    writeFileSync(join(d, 'CLAUDE.md'), broken);
    const r = takeBackAgentConfig(d);
    expect(text(d, 'CLAUDE.md')).toBe(broken);
    expect(r.removed).not.toContain('CLAUDE.md');
    expect(r.warnings.join('\n')).toMatch(/CLAUDE\.md: skipped: .*markers/);
    expect(existsSync(join(d, 'AGENTS.md'))).toBe(false);
  });

  it('refuses to remove the block from a Markdown file now linked outside the repository', () => {
    const d = dir();
    writeAgentConfig(d);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-out-')));
    made.push(outside);
    writeFileSync(join(outside, 'AGENTS.md'), text(d, 'AGENTS.md'));
    rmSync(join(d, 'AGENTS.md'));
    symlinkSync(join(outside, 'AGENTS.md'), join(d, 'AGENTS.md'));
    const before = text(outside, 'AGENTS.md');
    const err = conflictOf(() => removeAgentConfig(d));
    expect(err.file).toBe('AGENTS.md');
    expect(err.message).toMatch(/outside the repository/);
    expect(text(outside, 'AGENTS.md')).toBe(before);
    expect(existsSync(join(d, '.mcp.json'))).toBe(true); // nothing removed
  });

  it('refuses to remove from a file that is no longer valid JSON, changing nothing', () => {
    const d = dir();
    writeAgentConfig(d);
    writeFileSync(join(d, 'opencode.json'), '{ broken');
    const err = conflictOf(() => removeAgentConfig(d));
    expect(err.file).toBe('opencode.json');
    expect(existsSync(join(d, '.mcp.json'))).toBe(true);
    expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(true);
  });

  it('reports a built-in tool that is enabled again, and a missing server', () => {
    const d = dir();
    writeAgentConfig(d);
    const s = json(d, '.claude/settings.json');
    s.permissions.deny = s.permissions.deny.filter((t: string) => t !== 'Bash');
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
    const o = json(d, 'opencode.json');
    delete o.mcp.sandbox;
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(o));
    const problems = checkAgentConfig(d);
    expect(problems.join('\n')).toMatch(/Claude Code.*Bash/);
    expect(problems.join('\n')).toMatch(/OpenCode.*sandbox MCP server/);
  });

  it.each([
    [
      'an allow entry for a built-in',
      (d: string) => {
        const s = json(d, '.claude/settings.json');
        s.permissions.allow.push('Read');
        writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
      },
      /Claude Code.*allow.*Read/,
    ],
    [
      'an OpenCode tool switched on',
      (d: string) => {
        const o = json(d, 'opencode.json');
        o.tools.webfetch = true;
        writeFileSync(join(d, 'opencode.json'), JSON.stringify(o));
      },
      /OpenCode.*webfetch/,
    ],
    [
      'the server no longer pre-approved',
      (d: string) => {
        const s = json(d, '.claude/settings.json');
        delete s.enabledMcpjsonServers;
        writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
      },
      /Claude Code.*enabledMcpjsonServers/,
    ],
    [
      'the server rejected in settings.local.json',
      (d: string) =>
        writeFileSync(
          join(d, '.claude/settings.local.json'),
          JSON.stringify({ disabledMcpjsonServers: ['sandbox'] }),
        ),
      /Claude Code.*settings\.local\.json.*disabledMcpjsonServers/,
    ],
    [
      'the rules block removed',
      (d: string) => writeFileSync(join(d, 'AGENTS.md'), '# none\n'),
      /AGENTS\.md/,
    ],
    [
      'a file broken by hand',
      (d: string) => writeFileSync(join(d, '.mcp.json'), '{'),
      /\.mcp\.json.*not valid JSON/,
    ],
    [
      'an OpenCode agent that switches a tool back on',
      (d: string) => {
        const o = json(d, 'opencode.json');
        o.agent = { build: { tools: { bash: true } } };
        o.permission = { edit: 'allow' };
        writeFileSync(join(d, 'opencode.json'), JSON.stringify(o));
      },
      /OpenCode: opencode\.json re-enables local built-in tools: agent\.build\.tools\.bash, permission\.edit/,
    ],
    [
      'no configuration at all',
      (d: string) => {
        for (const f of FILES) rmSync(join(d, f));
      },
      /Claude Code[\s\S]*OpenCode/,
    ],
  ])('doctor finds %s', (_what, spoil, re) => {
    const d = dir();
    writeAgentConfig(d);
    spoil(d);
    expect(checkAgentConfig(d).join('\n')).toMatch(re);
  });
});
