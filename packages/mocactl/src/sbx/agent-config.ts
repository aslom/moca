import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { append, remove, styleOf, type Style } from './json-edit.js';

/**
 * The agent configuration `sbx up` writes (SBX0 spec §6.3): Claude Code and OpenCode pointed at the
 * sandbox MCP server, with every local built-in tool that would act on the laptop denied.
 *
 * It is MERGED into what the developer has and never overwrites: a key is added, an array item
 * appended, a Markdown block put between markers; a value already there that disagrees stops
 * `sbx up` (a `ConfigConflict` naming the file and key). JSON is edited in place (json-edit.ts), so
 * the file keeps its indentation, key order, line endings and, in OpenCode's JSONC, its comments;
 * removal undoes an insertion byte for byte.
 * Every write is atomic (a temp file, then a rename) and keeps the file's mode.
 *
 * What was added is recorded in `.sbx/agent-config.json`, so `removeAgentConfig` takes back exactly
 * that and never a value the developer had. The tool lists live here, in one place, because the
 * agents add tools: `sbx doctor` checks against these lists (`checkAgentConfig`), so the denied state
 * is checked, not assumed.
 */

/** Claude Code's built-ins that act on the laptop: denied (spec §6.3). */
export const CLAUDE_DENY: readonly string[] = Object.freeze([
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
/** OpenCode's built-ins that act on the laptop: `tools.<t> = false` (spec §6.3). */
export const OPENCODE_OFF: readonly string[] = Object.freeze([
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
]);
export const MARK_BEGIN = '<!-- sbx:begin -->';
export const MARK_END = '<!-- sbx:end -->';
/** The CLAUDE.md / AGENTS.md block body (spec §6.3). */
export const RULES = [
  '## Working in the MOCA sandbox',
  '',
  'The code lives in a remote sandbox at `/workspace`: use the `sandbox` MCP tools for everything.',
  '',
  '- Every tool call runs in a fresh VM, and no process survives it. Never start background jobs, servers or watchers expecting them to keep running; chain the work into one command instead.',
  '- Files under `/workspace` persist between calls; nothing else does.',
  '- There is no network: packages cannot be installed from the internet.',
  '- Calls run one at a time, so batch the work: read several files in one `bash` call, and run the tests in one call after editing.',
].join('\n');

/** The server name in every file: Claude Code's tools are then `mcp__sandbox__*`. */
export const SERVER = 'sandbox';
export const CLAUDE_SERVER = Object.freeze({ command: 'mocactl', args: ['sbx', 'mcp'] });
export const OPENCODE_SERVER = Object.freeze({
  type: 'local',
  command: ['mocactl', 'sbx', 'mcp'],
  enabled: true,
});
export const CLAUDE_ALLOW = 'mcp__sandbox__*';

const MCP_JSON = '.mcp.json';
const SETTINGS = '.claude/settings.json';
const SETTINGS_LOCAL = '.claude/settings.local.json';
const MANIFEST = '.sbx/agent-config.json';
const WRITE_HINT = 'edit it by hand, or run mocactl sbx up --no-agent-config';

export class ConfigConflict extends Error {
  constructor(
    readonly file: string,
    readonly key: string,
    why: string,
    hint: string = WRITE_HINT,
  ) {
    super(`${key === file ? file : `${file}: ${key}`} ${why}; ${hint}`);
    this.name = 'ConfigConflict';
  }
}

export interface AgentConfigResult {
  /** The files written (or, in a dry run, that would be), relative to the repository root. */
  changed: string[];
}

type Json = Record<string, unknown>;
type JsonPath = string[];

/** One thing `sbx up` added to a JSON file, so removal can take back exactly it. */
type JsonRec =
  | { file: string; op: 'key'; path: JsonPath; value: unknown }
  | { file: string; op: 'item'; path: JsonPath; value: unknown }
  | { file: string; op: 'container'; path: JsonPath };
type MdRec =
  | { file: string; mode: 'created' }
  | { file: string; mode: 'appended'; before: string; after: string }
  | { file: string; mode: 'replaced'; previous: string };
interface Manifest {
  version: 1;
  /** Files `sbx up` created: deleted when nothing but its own content is left. */
  files: string[];
  /** Directories it created (`.claude`): removed when empty. */
  dirs: string[];
  json: JsonRec[];
  markdown: MdRec[];
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const emptyOrNone = (v: unknown) => v === undefined || (isObj(v) && Object.keys(v).length === 0);
const onlyKeys = (v: Json, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));

/** `mocactl sbx mcp` as Claude Code's server, written as ours or by hand (`type: stdio`, no env). */
function isClaudeServer(v: unknown): boolean {
  return (
    isObj(v) &&
    v.command === CLAUDE_SERVER.command &&
    same(v.args, CLAUDE_SERVER.args) &&
    (v.type === undefined || v.type === 'stdio') &&
    emptyOrNone(v.env) &&
    onlyKeys(v, ['command', 'args', 'type', 'env'])
  );
}

/** `mocactl sbx mcp` as OpenCode's server, enabled. */
function isOpencodeServer(v: unknown): boolean {
  return (
    isObj(v) &&
    v.type === 'local' &&
    same(v.command, OPENCODE_SERVER.command) &&
    (v.enabled === undefined || v.enabled === true) &&
    emptyOrNone(v.environment) &&
    onlyKeys(v, ['type', 'command', 'enabled', 'environment'])
  );
}

/** A Claude Code permission rule's tool: `Bash(npm test)` is `Bash`. */
const ruleTool = (r: unknown) => (typeof r === 'string' ? r.replace(/\(.*$/s, '').trim() : '');

// ---------------------------------------------------------------------------------------------
// Files

interface Target {
  /** Relative to the repository root, after following links. */
  rel: string;
  abs: string;
  exists: boolean;
}

/**
 * Where `rel` really is. A link is followed (CLAUDE.md is often a link to AGENTS.md) but only
 * within the repository: a link to a file outside it (a dotfiles settings.json) is refused, as is
 * a link to nothing.
 */
function target(root: string, rel: string, hint = WRITE_HINT): Target {
  const rroot = realpathSync(root);
  const abs = join(rroot, rel);
  let real: string;
  let exists = false;
  let linked = false;
  try {
    linked = lstatSync(abs).isSymbolicLink();
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    try {
      real = realpathSync(abs);
    } catch {
      throw new ConfigConflict(rel, rel, 'is a link to nothing', hint);
    }
    if (!statSync(real).isFile()) throw new ConfigConflict(rel, rel, 'is not a file', hint);
  } else {
    let dir = dirname(abs);
    const tail = [basename(abs)];
    while (!existsSync(dir) && dir !== rroot) {
      tail.unshift(basename(dir));
      dir = dirname(dir);
    }
    real = join(realpathSync(dir), ...tail);
  }
  if (!(real === rroot || real.startsWith(rroot + sep))) {
    throw new ConfigConflict(
      rel,
      rel,
      `is ${linked ? 'a link' : 'in a directory linked'} outside the repository`,
      hint,
    );
  }
  return { rel: relative(rroot, real).split(sep).join('/'), abs: real, exists };
}

/** Atomic: a temp file beside it, renamed over it; the existing file's mode is kept. */
function writeAtomic(abs: string, body: string, mode?: number): void {
  const old = existsSync(abs) ? statSync(abs).mode & 0o7777 : undefined;
  const m = mode ?? old;
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, body, m !== undefined ? { mode: m } : {});
    if (m !== undefined) chmodSync(tmp, m); // the umask does not narrow the kept mode
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON documents

interface Doc extends Target {
  text: string;
  data: Json;
  style: Style;
  jsonc: boolean;
  /** The text as read ('' for a file that does not exist yet). */
  original: string;
}

/** Parses JSON (or, for `jsonc`, JSON with comments and trailing commas, as OpenCode reads it). */
function parseDoc(text: string, jsonc: boolean): unknown {
  const errors: ParseError[] = [];
  const v = parse(text, errors, {
    disallowComments: !jsonc,
    allowTrailingComma: jsonc,
    allowEmptyContent: false,
  }) as unknown;
  return errors.length ? undefined : v === undefined ? undefined : v;
}

/** The document at `rel`, an empty one if missing; a file that is not a JSON object is refused. */
function loadDoc(root: string, rel: string, jsonc: boolean, hint = WRITE_HINT): Doc {
  const t = target(root, rel, hint);
  if (!t.exists) {
    return {
      ...t,
      text: '{}',
      data: {},
      style: styleOf(''),
      jsonc,
      original: '',
    };
  }
  const text = readFileSync(t.abs, 'utf8');
  const v = parseDoc(text, jsonc);
  if (v === undefined) {
    throw new ConfigConflict(
      t.rel,
      t.rel,
      jsonc ? 'is not valid JSON (or JSONC)' : 'is not valid JSON (Claude Code reads no comments)',
      hint,
    );
  }
  if (!isObj(v)) throw new ConfigConflict(t.rel, t.rel, 'is not a JSON object', hint);
  return { ...t, text, data: v, style: styleOf(text), jsonc, original: text };
}

function at(data: unknown, path: (string | number)[]): unknown {
  let cur = data;
  for (const k of path) {
    if (typeof k === 'number') cur = Array.isArray(cur) ? cur[k] : undefined;
    else cur = isObj(cur) ? cur[k] : undefined;
  }
  return cur;
}

function edit(doc: Doc, f: (text: string) => string): void {
  doc.text = f(doc.text);
  const v = parseDoc(doc.text, doc.jsonc);
  // Every edit is made by this module on a document it parsed: anything else is a bug here.
  if (!isObj(v)) throw new Error(`editing ${doc.rel} produced a document that does not parse`);
  doc.data = v;
}

/** Sets `path` (which is absent) to `value`, creating the objects above it that are missing. */
function addKey(doc: Doc, path: JsonPath, value: unknown): void {
  let i = path.length - 1;
  while (i > 0 && at(doc.data, path.slice(0, i)) === undefined) i--;
  let v = value;
  for (let j = path.length - 1; j > i; j--) v = { [path[j]!]: v };
  edit(doc, (t) => append(t, path.slice(0, i), path[i]!, v, doc.style));
}

function dropAt(doc: Doc, path: (string | number)[]): void {
  edit(doc, (t) => remove(t, path));
}

/** Refuses a key on `path` whose value is there but not an object (it cannot be merged into). */
function needObjects(doc: Doc, path: JsonPath): void {
  for (let i = 1; i <= path.length; i++) {
    const v = at(doc.data, path.slice(0, i));
    if (v !== undefined && !isObj(v)) {
      throw new ConfigConflict(doc.rel, path.slice(0, i).join('.'), 'is there but not an object');
    }
  }
}

function needArray(doc: Doc, path: JsonPath): unknown[] {
  needObjects(doc, path.slice(0, -1));
  const v = at(doc.data, path);
  if (v !== undefined && !Array.isArray(v)) {
    throw new ConfigConflict(doc.rel, path.join('.'), 'is there but not a list');
  }
  return (v as unknown[] | undefined) ?? [];
}

/** Records every container on `path` that does not exist yet (it is created by the next edit). */
function recordMissing(doc: Doc, path: JsonPath, recs: JsonRec[]): void {
  for (let i = 1; i <= path.length; i++) {
    const p = path.slice(0, i);
    if (at(doc.data, p) === undefined) recs.push({ file: doc.rel, op: 'container', path: p });
  }
}

function setKey(doc: Doc, path: JsonPath, value: unknown, recs: JsonRec[]): void {
  recordMissing(doc, path.slice(0, -1), recs);
  addKey(doc, path, value);
  recs.push({ file: doc.rel, op: 'key', path, value });
}

function addItems(doc: Doc, path: JsonPath, values: unknown[], recs: JsonRec[]): void {
  if (!values.length) return;
  if (at(doc.data, path) === undefined) {
    recordMissing(doc, path, recs);
    addKey(doc, path, values);
  } else {
    for (const v of values) edit(doc, (t) => append(t, path, undefined, v, doc.style));
  }
  for (const v of values) recs.push({ file: doc.rel, op: 'item', path, value: v });
}

/** The doc's new text: a file created here ends with a newline. */
function finalText(doc: Doc): string {
  if (!doc.exists && !doc.text.endsWith(doc.style.eol)) return doc.text + doc.style.eol;
  return doc.text;
}

// ---------------------------------------------------------------------------------------------
// The files `up` merges into

/** OpenCode reads `opencode.json` or `opencode.jsonc`: the one the repository has (never both). */
function opencodeFile(root: string, hint = WRITE_HINT): string {
  const json = existsSync(join(root, 'opencode.json'));
  const jsonc = existsSync(join(root, 'opencode.jsonc'));
  if (json && jsonc) {
    throw new ConfigConflict(
      'opencode.json',
      'opencode.json',
      'and opencode.jsonc are both here, and it is not clear which OpenCode reads',
      hint,
    );
  }
  return jsonc ? 'opencode.jsonc' : 'opencode.json';
}

/** `disabledMcpjsonServers` naming the sandbox in a settings file: Claude Code then rejects it. */
function rejectsServer(data: Json | undefined): boolean {
  const d = data?.disabledMcpjsonServers;
  return Array.isArray(d) && d.includes(SERVER);
}

/** settings.local.json, read only (it is the developer's own): undefined when absent or unreadable. */
function readLocalSettings(root: string): Json | undefined {
  try {
    const t = target(root, SETTINGS_LOCAL);
    if (!t.exists) return undefined;
    const v = parseDoc(readFileSync(t.abs, 'utf8'), false);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

interface MdPlan {
  t: Target;
  before: string | undefined;
  after: string;
  rec?: MdRec;
}

/** The block, in the file's own line endings. */
const blockFor = (eol: string) => [MARK_BEGIN, ...RULES.split('\n'), MARK_END].join(eol);

/** Where the markers are; refused unless there is no marker or exactly one well-ordered pair. */
function markers(rel: string, text: string, hint = WRITE_HINT): [number, number] | undefined {
  const count = (m: string) => text.split(m).length - 1;
  const nb = count(MARK_BEGIN);
  const ne = count(MARK_END);
  if (nb === 0 && ne === 0) return undefined;
  const b = text.indexOf(MARK_BEGIN);
  const e = text.indexOf(MARK_END);
  if (nb !== 1 || ne !== 1 || e < b) {
    throw new ConfigConflict(
      rel,
      `the ${MARK_BEGIN} … ${MARK_END} markers`,
      'are not one well-formed pair',
      hint,
    );
  }
  return [b, e + MARK_END.length];
}

function planMarkdown(root: string, rel: string): MdPlan {
  const t = target(root, rel);
  if (!t.exists) {
    const after = `${blockFor('\n')}\n`;
    return { t, before: undefined, after, rec: { file: t.rel, mode: 'created' } };
  }
  const text = readFileSync(t.abs, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = blockFor(eol);
  const m = markers(t.rel, text);
  if (m) {
    const previous = text.slice(m[0], m[1]);
    if (previous === block) return { t, before: text, after: text };
    return {
      t,
      before: text,
      after: text.slice(0, m[0]) + block + text.slice(m[1]),
      rec: { file: t.rel, mode: 'replaced', previous },
    };
  }
  const lead = text === '' ? '' : text.endsWith(eol) ? eol : eol + eol;
  return {
    t,
    before: text,
    after: text + lead + block + eol,
    rec: { file: t.rel, mode: 'appended', before: lead, after: eol },
  };
}

function readManifest(root: string): Manifest | undefined {
  const p = join(root, MANIFEST);
  if (!existsSync(p)) return undefined;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as Partial<Manifest>;
    if (m.version !== 1) return undefined;
    return {
      version: 1,
      files: m.files ?? [],
      dirs: m.dirs ?? [],
      json: m.json ?? [],
      markdown: m.markdown ?? [],
    };
  } catch {
    return undefined;
  }
}

const uniq = <T>(xs: T[]): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Merges the agent configuration into the repository at `root` (spec §6.3). Everything is read and
 * checked before anything is written, so a conflict in any file (a `ConfigConflict`) writes
 * nothing anywhere. `dryRun` checks and reports what would change, writing nothing: `sbx up` runs
 * it before it creates or pushes anything.
 */
export function writeAgentConfig(root: string, o: { dryRun?: boolean } = {}): AgentConfigResult {
  const recs: JsonRec[] = [];
  const created: string[] = [];
  const dirs: string[] = [];

  // Read and check every file first.
  const mcp = loadDoc(root, MCP_JSON, false);
  const settings = loadDoc(root, SETTINGS, false);
  const oc = loadDoc(root, opencodeFile(root), true);
  const local = readLocalSettings(root);

  needObjects(mcp, ['mcpServers']);
  const have = at(mcp.data, ['mcpServers', SERVER]);
  if (have !== undefined && !isClaudeServer(have)) {
    throw new ConfigConflict(mcp.rel, `mcpServers.${SERVER}`, 'is there and names another server');
  }

  needObjects(settings, ['permissions']);
  const allow = needArray(settings, ['permissions', 'allow']);
  const deny = needArray(settings, ['permissions', 'deny']);
  const enabled = needArray(settings, ['enabledMcpjsonServers']);
  const reenabled = allow.filter((a) => CLAUDE_DENY.includes(ruleTool(a)));
  if (reenabled.length) {
    throw new ConfigConflict(
      settings.rel,
      'permissions.allow',
      `lists local built-in tools (${reenabled.join(', ')}), which would act on this machine`,
    );
  }
  for (const [file, data] of [
    [settings.rel, settings.data],
    [SETTINGS_LOCAL, local],
  ] as const) {
    if (rejectsServer(data)) {
      throw new ConfigConflict(
        file,
        'disabledMcpjsonServers',
        `rejects the ${SERVER} MCP server, so Claude Code would have no tools`,
      );
    }
  }

  needObjects(oc, ['mcp']);
  needObjects(oc, ['tools']);
  const ocHave = at(oc.data, ['mcp', SERVER]);
  if (ocHave !== undefined && !isOpencodeServer(ocHave)) {
    throw new ConfigConflict(
      oc.rel,
      `mcp.${SERVER}`,
      'is there and is not an enabled mocactl sbx mcp',
    );
  }
  for (const t of OPENCODE_OFF) {
    const v = at(oc.data, ['tools', t]);
    if (v !== undefined && v !== false) {
      throw new ConfigConflict(
        oc.rel,
        `tools.${t}`,
        `is ${JSON.stringify(v)}: the local tool would act on this machine`,
      );
    }
  }

  // The Markdown files, once each (CLAUDE.md is often a link to AGENTS.md).
  const md: MdPlan[] = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const t = target(root, f);
    if (md.some((p) => p.t.abs === t.abs)) continue;
    md.push(planMarkdown(root, f));
  }

  // Then merge, in memory.
  if (have === undefined) setKey(mcp, ['mcpServers', SERVER], { ...CLAUDE_SERVER }, recs);
  addItems(
    settings,
    ['permissions', 'allow'],
    allow.includes(CLAUDE_ALLOW) ? [] : [CLAUDE_ALLOW],
    recs,
  );
  addItems(
    settings,
    ['permissions', 'deny'],
    CLAUDE_DENY.filter((t) => !deny.includes(t)),
    recs,
  );
  addItems(settings, ['enabledMcpjsonServers'], enabled.includes(SERVER) ? [] : [SERVER], recs);
  if (ocHave === undefined) setKey(oc, ['mcp', SERVER], { ...OPENCODE_SERVER }, recs);
  for (const t of OPENCODE_OFF) {
    if (at(oc.data, ['tools', t]) === undefined) setKey(oc, ['tools', t], false, recs);
  }

  const writes: { t: Target; body: string }[] = [];
  for (const d of [mcp, settings, oc]) {
    const body = finalText(d);
    if (d.exists && body === d.original) continue;
    if (!d.exists && !recs.some((r) => r.file === d.rel)) continue;
    writes.push({ t: d, body });
    if (!d.exists) created.push(d.rel);
  }
  for (const p of md) {
    if (p.before === p.after) continue;
    writes.push({ t: p.t, body: p.after });
    if (!p.t.exists) created.push(p.t.rel);
  }
  if (!settings.exists && writes.some((w) => w.t.rel === settings.rel)) {
    const dir = dirname(SETTINGS);
    if (!existsSync(join(root, dir))) dirs.push(dir);
  }
  const changed = writes.map((w) => w.t.rel);
  if (o.dryRun || !writes.length) return { changed };

  // The record first: if a write below fails, removal still knows what may have been added.
  const prev = readManifest(root);
  const mdRecs = md.flatMap((p) => (p.rec ? [p.rec] : []));
  const merged: Manifest = {
    version: 1,
    files: uniq([...(prev?.files ?? []), ...created]),
    dirs: uniq([...(prev?.dirs ?? []), ...dirs]),
    json: uniq([...(prev?.json ?? []), ...recs]),
    // An earlier run's record of a file wins: it knows what was there before sbx touched it.
    markdown: [
      ...(prev?.markdown ?? []),
      ...mdRecs.filter((r) => !prev?.markdown.some((p) => p.file === r.file)),
    ],
  };
  mkdirSync(join(root, '.sbx'), { recursive: true });
  writeAtomic(join(root, MANIFEST), JSON.stringify(merged, null, 2) + '\n', 0o600);
  for (const w of writes) writeAtomic(w.t.abs, w.body);
  return { changed };
}

// ---------------------------------------------------------------------------------------------
// Removal

const RM_HINT = 'fix it by hand, then run mocactl sbx rm again (nothing was removed)';

/** Removes the block `sbx up` put in a Markdown file, restoring what it replaced. */
function unblock(text: string, rec: MdRec): string | undefined {
  let m: [number, number] | undefined;
  try {
    m = markers(rec.file, text, RM_HINT);
  } catch {
    return undefined; // the developer has edited the markers since: theirs now
  }
  if (!m) return undefined;
  const [b, e] = m;
  if (rec.mode === 'replaced') return text.slice(0, b) + rec.previous + text.slice(e);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lead = rec.mode === 'appended' ? rec.before : '';
  const trail = rec.mode === 'appended' ? rec.after : eol;
  const start = lead && text.slice(b - lead.length, b) === lead ? b - lead.length : b;
  const end = text.slice(e, e + trail.length) === trail ? e + trail.length : e;
  return text.slice(0, start) + text.slice(end);
}

/**
 * Takes back exactly what `writeAgentConfig` added (`.sbx/agent-config.json`), and deletes the files
 * and directory it created when nothing else is left in them. A value the developer had, or added
 * since, is kept. Every file is read and checked before any is changed: one that is no longer
 * valid JSON stops it (a `ConfigConflict`) with nothing removed. Returns the files changed.
 */
export function removeAgentConfig(root: string): string[] {
  const m = readManifest(root);
  if (!m) return [];
  const files = uniq(m.json.map((r) => r.file));
  const docs: Doc[] = [];
  for (const f of files) {
    if (!existsSync(join(root, f))) continue;
    docs.push(loadDoc(root, f, f.startsWith('opencode.'), RM_HINT));
  }
  const touched: string[] = [];
  const writes: { abs: string; body?: string }[] = [];
  for (const d of docs) {
    const mine = m.json.filter((r) => r.file === d.rel);
    for (const r of mine) {
      if (r.op !== 'item') continue;
      const arr = at(d.data, r.path);
      if (!Array.isArray(arr)) continue;
      let i = arr.length - 1;
      while (i >= 0 && !same(arr[i], r.value)) i--;
      if (i >= 0) dropAt(d, [...r.path, i]);
    }
    for (const r of mine) {
      if (r.op === 'key' && same(at(d.data, r.path), r.value)) dropAt(d, r.path);
    }
    const containers = mine
      .filter((r) => r.op === 'container')
      .sort((a, b) => b.path.length - a.path.length);
    for (const r of containers) {
      const v = at(d.data, r.path);
      const empty = Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0;
      if (empty) dropAt(d, r.path);
    }
    if (m.files.includes(d.rel) && Object.keys(d.data).length === 0) {
      writes.push({ abs: d.abs });
      touched.push(d.rel);
    } else if (d.text !== d.original) {
      writes.push({ abs: d.abs, body: d.text });
      touched.push(d.rel);
    }
  }
  for (const r of m.markdown) {
    const p = join(root, r.file);
    if (!existsSync(p)) continue;
    const abs = realpathSync(p);
    const text = readFileSync(abs, 'utf8');
    const out = unblock(text, r);
    if (out === undefined || out === text) continue;
    if (r.mode === 'created' && out.trim() === '') writes.push({ abs });
    else writes.push({ abs, body: out });
    touched.push(r.file);
  }
  for (const w of writes) {
    if (w.body === undefined) rmSync(w.abs, { force: true });
    else writeAtomic(w.abs, w.body);
  }
  for (const d of m.dirs) {
    const p = join(root, d);
    try {
      if (readdirSync(p).length === 0) rmdirSync(p);
    } catch {
      // gone already, or not a directory: nothing to take back
    }
  }
  rmSync(join(root, MANIFEST), { force: true });
  return touched;
}

// ---------------------------------------------------------------------------------------------
// The check `sbx doctor` makes

/**
 * Whether the denied state holds (spec §6.1, §6.3): each agent has the sandbox server, and every
 * local built-in in this module's lists is denied. One line per problem; [] when it all holds.
 */
export function checkAgentConfig(root: string): string[] {
  const problems: string[] = [];
  const load = (rel: string, jsonc: boolean): Json | undefined => {
    try {
      const d = loadDoc(root, rel, jsonc, 'mocactl sbx up re-merges it once fixed');
      return d.exists ? d.data : undefined;
    } catch (err) {
      problems.push((err as Error).message);
      return undefined;
    }
  };
  let ocFile = 'opencode.json';
  try {
    ocFile = opencodeFile(root, 'keep one');
  } catch (err) {
    problems.push((err as Error).message);
  }
  const mcp = load(MCP_JSON, false);
  const settings = load(SETTINGS, false);
  const oc = load(ocFile, true);
  const local = readLocalSettings(root);

  if (!isClaudeServer(at(mcp, ['mcpServers', SERVER]))) {
    problems.push(`Claude Code: ${MCP_JSON} has no ${SERVER} MCP server (mocactl sbx mcp)`);
  }
  const deny = at(settings, ['permissions', 'deny']);
  const denied = Array.isArray(deny) ? deny : [];
  const missing = CLAUDE_DENY.filter((t) => !denied.includes(t));
  if (missing.length) {
    problems.push(
      `Claude Code: local built-in tools not denied in ${SETTINGS}: ${missing.join(', ')}`,
    );
  }
  const allow = at(settings, ['permissions', 'allow']);
  const allowed = (Array.isArray(allow) ? allow : []).filter((a) =>
    CLAUDE_DENY.includes(ruleTool(a)),
  );
  if (allowed.length) {
    problems.push(
      `Claude Code: ${SETTINGS} permissions.allow lists local built-in tools: ${allowed.join(', ')}`,
    );
  }
  const enabled = at(settings, ['enabledMcpjsonServers']);
  if (
    !(Array.isArray(enabled) && enabled.includes(SERVER)) &&
    at(settings, ['enableAllProjectMcpServers']) !== true
  ) {
    problems.push(
      `Claude Code: ${SETTINGS} enabledMcpjsonServers does not list ${SERVER}, so Claude Code asks before loading it`,
    );
  }
  for (const [file, data] of [
    [SETTINGS, settings],
    [SETTINGS_LOCAL, local],
  ] as const) {
    if (rejectsServer(data)) {
      problems.push(`Claude Code: ${file} disabledMcpjsonServers rejects the ${SERVER} MCP server`);
    }
  }
  if (!isOpencodeServer(at(oc, ['mcp', SERVER]))) {
    problems.push(`OpenCode: ${ocFile} has no enabled ${SERVER} MCP server (mocactl sbx mcp)`);
  }
  const on = OPENCODE_OFF.filter((t) => at(oc, ['tools', t]) !== false);
  if (on.length) {
    problems.push(`OpenCode: local built-in tools not disabled in ${ocFile}: ${on.join(', ')}`);
  }
  const seen = new Set<string>();
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const t = target(root, f, 'mocactl sbx up re-merges it once fixed');
      if (seen.has(t.abs)) continue;
      seen.add(t.abs);
      const text = t.exists ? readFileSync(t.abs, 'utf8') : '';
      const mk = markers(t.rel, text, 'mocactl sbx up re-merges it once fixed');
      const body = mk ? text.slice(mk[0], mk[1]).replace(/\r\n/g, '\n') : undefined;
      if (body !== blockFor('\n')) {
        problems.push(
          `${f}: ${body === undefined ? 'has no' : 'has an out-of-date'} sandbox rules block`,
        );
      }
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return problems;
}
