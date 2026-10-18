import { createScanner, findNodeAtLocation, parseTree, SyntaxKind, type Node } from 'jsonc-parser';

/**
 * Minimal, style-keeping edits to a JSON (or JSONC) document's text, for agent-config.ts: append a
 * member to an object or an array, and remove one. Nothing else in the file is touched, so its
 * indentation, key order, line endings, comments and trailing commas survive, and a removal undoes
 * an insertion byte for byte. (jsonc-parser's own `modify` reformats the lines around an edit and
 * corrupts a compact array when it removes the last item, so only its parser and scanner are used.)
 */

export interface Style {
  /** One indentation level: spaces or a tab. */
  unit: string;
  eol: string;
}

export function styleOf(text: string): Style {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  return { unit: indent ? (indent.startsWith('\t') ? '\t' : indent) : '  ', eol };
}

const isWs = (ch: string) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

function tree(text: string): Node {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root) throw new Error('not a JSON document');
  return root;
}

/** The line's leading whitespace, for the line holding `offset`. */
function lineIndent(text: string, offset: number): string {
  let s = offset;
  while (s > 0 && text[s - 1] !== '\n') s--;
  let e = s;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(s, e);
}

/** Whether `offset` is the first non-blank character on its line. */
function startsLine(text: string, offset: number): boolean {
  let s = offset;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  return s === 0 || text[s - 1] === '\n';
}

/** The offsets of commas (outside comments) in [from, to). */
function commas(text: string, from: number, to: number): number[] {
  const sc = createScanner(text, false);
  sc.setPosition(from);
  const out: number[] = [];
  for (let k = sc.scan(); k !== SyntaxKind.EOF && sc.getTokenOffset() < to; k = sc.scan()) {
    if (k === SyntaxKind.CommaToken) out.push(sc.getTokenOffset());
  }
  return out;
}

/** The unit an object member or array item occupies: the property node, or the item itself. */
const unitOf = (n: Node) => (n.parent?.type === 'property' ? n.parent : n);

function render(value: unknown, s: Style, indent: string | undefined): string {
  if (indent === undefined) return JSON.stringify(value);
  return JSON.stringify(value, null, s.unit)
    .split('\n')
    .join(s.eol + indent);
}

/**
 * Appends `key: value` to the object at `path` (or `value` to the array there, `key` undefined),
 * in the container's own style: one member per line, indented as its siblings, when the container
 * spans lines (or is the document's empty root); else inline.
 */
export function append(
  text: string,
  path: string[],
  key: string | undefined,
  value: unknown,
  s: Style,
): string {
  const root = tree(text);
  const c = path.length ? findNodeAtLocation(root, path) : root;
  if (!c || (c.type !== 'object' && c.type !== 'array')) throw new Error(`no container at ${path}`);
  const kids = c.children ?? [];
  const open = c.offset;
  const close = c.offset + c.length - 1;
  const multi = text.slice(open, close).includes('\n') || (c === root && kids.length === 0);
  // A minified document stays minified; anything else gets JSON's usual `, ` and `: `.
  const minified = !/\s/.test(text.trim());
  const member = (indent: string | undefined) =>
    (key !== undefined
      ? JSON.stringify(key) + (minified && indent === undefined ? ':' : ': ')
      : '') + render(value, s, indent);

  if (!multi) {
    if (!kids.length) return text.slice(0, open + 1) + member(undefined) + text.slice(open + 1);
    const last = kids[kids.length - 1]!;
    const end = last.offset + last.length;
    const sep = commas(text, open, close).map((k) => isWs(text[k + 1] ?? ''));
    const sp = (sep.length ? sep[sep.length - 1] : !minified) ? ' ' : '';
    return text.slice(0, end) + ',' + sp + member(undefined) + text.slice(end);
  }
  if (!kids.length) {
    const base = lineIndent(text, close);
    const ind = base + s.unit;
    const inner = text.slice(open + 1, close);
    // An empty container's inside is only whitespace (or comments, kept before the member).
    const keep = inner.trim() ? inner.replace(/\s+$/, '') : '';
    return (
      text.slice(0, open + 1) + keep + s.eol + ind + member(ind) + s.eol + base + text.slice(close)
    );
  }
  const last = unitOf(kids[kids.length - 1]!);
  const end = last.offset + last.length;
  const trailing = commas(text, end, close)[0];
  const ind = startsLine(text, last.offset)
    ? lineIndent(text, last.offset)
    : lineIndent(text, open) + s.unit;
  // After the last member's line (a comment there stays with it), or before the closing bracket
  // when that is on the same line.
  const after = trailing !== undefined ? trailing + 1 : end;
  let at = after;
  while (at < close && text[at] !== '\n' && text[at] !== '\r') at++;
  if (at >= close) at = after;
  const add = s.eol + ind + member(ind) + (trailing !== undefined ? ',' : '');
  if (trailing !== undefined) return text.slice(0, at) + add + text.slice(at);
  return text.slice(0, end) + ',' + text.slice(end, at) + add + text.slice(at);
}

/** Removes the member at `path` (an object key, or an array index), undoing `append`. */
export function remove(text: string, path: (string | number)[]): string {
  const root = tree(text);
  const n = findNodeAtLocation(root, path);
  if (!n) return text;
  const u = unitOf(n);
  const c = u.parent!;
  const kids = (c.children ?? []).map(unitOf);
  const i = kids.indexOf(u);
  const close = c.offset + c.length - 1;
  let start = u.offset;
  while (start > c.offset + 1 && isWs(text[start - 1]!)) start--;
  const end = u.offset + u.length;
  if (i > 0) {
    // The comma that separated it from the one before goes, and the whitespace leading up to it;
    // a comment between them stays.
    const prev = kids[i - 1]!;
    const comma = commas(text, prev.offset + prev.length, u.offset)[0];
    const head =
      comma === undefined
        ? text.slice(0, start)
        : text.slice(0, comma) + text.slice(comma + 1, start);
    return head + text.slice(end);
  }
  if (kids.length > 1) {
    const next = kids[1]!;
    const comma = commas(text, end, next.offset)[0];
    return text.slice(0, start) + text.slice(comma !== undefined ? comma + 1 : end);
  }
  // The only member: the container is left empty (`{}` / `[]` when only whitespace is left).
  const comma = commas(text, end, close)[0];
  const inside =
    text.slice(c.offset + 1, start) + text.slice(comma !== undefined ? comma + 1 : end, close);
  return text.slice(0, c.offset + 1) + (inside.trim() === '' ? '' : inside) + text.slice(close);
}
