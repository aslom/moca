import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { append, remove, styleOf } from '../src/sbx/json-edit.js';

const val = (t: string) => parse(t, [], { allowTrailingComma: true }) as unknown;

/** Appends, checks the value, removes, and checks the bytes are back. */
function roundTrip(text: string, path: string[], key: string | undefined, value: unknown) {
  const s = styleOf(text);
  const out = append(text, path, key, value, s);
  const before = val(text) as Record<string, unknown>;
  const after = val(out) as Record<string, unknown>;
  let cur: unknown = after;
  for (const k of path) cur = (cur as Record<string, unknown>)[k];
  if (key === undefined) {
    expect((cur as unknown[]).at(-1)).toEqual(value);
    const idx = (cur as unknown[]).length - 1;
    expect(remove(out, [...path, idx])).toBe(text);
  } else {
    expect((cur as Record<string, unknown>)[key]).toEqual(value);
    expect(remove(out, [...path, key])).toBe(text);
  }
  expect(before).toBeDefined();
  return out;
}

describe('style-keeping JSON edits', () => {
  it.each([
    ['multi-line object', '{\n  "a": 1\n}\n', [], 'b', { x: [1, 2] }],
    [
      'an inline object inside',
      '{\n  "s": {\n    "g": { "t": "h", "u": "v" }\n  }\n}\n',
      ['s'],
      'n',
      { c: 'm' },
    ],
    ['tabs', '{\n\t"s": {\n\t\t"g": 1\n\t}\n}\n', ['s'], 'n', { c: ['a'] }],
    ['CRLF', '{\r\n  "a": 1\r\n}\r\n', [], 'b', { c: 1 }],
    ['four spaces', '{\n    "a": 1\n}', [], 'b', true],
    ['a trailing comma (JSONC)', '{\n  "a": 1,\n}\n', [], 'b', false],
    ['an inline trailing comma (JSONC)', '{ "t": { "bash": false, } }', ['t'], 'read', false],
    ['a comment after the last member', '{\n  "a": 1 // mine\n}\n', [], 'b', 2],
    ['a comment line before the end', '{\n  "a": 1\n  // later\n}\n', [], 'b', 2],
    ['the closing brace on the last line', '{\n  "a": 1}', [], 'b', 2],
    ['minified', '{"a":{"b":1},"c":[1]}', [], 'd', { e: [1] }],
    ['inline', '{ "a": 1, "b": 2 }', [], 'c', 3],
    ['an empty root', '{}', [], 'a', { b: 1 }],
    ['an empty inner object', '{\n  "a": {}\n}\n', ['a'], 'b', 1],
  ])('object: %s', (_n, text, path, key, value) => {
    roundTrip(text, path as string[], key as string, value);
  });

  it.each([
    ['multi-line', '{\n  "d": [\n    "Bash"\n  ]\n}\n', 'Read'],
    ['inline', '{\n  "d": ["Bash"]\n}\n', 'Read'],
    ['inline, two', '{\n  "d": ["Bash", "Edit"]\n}\n', 'Read'],
    ['compact', '{"d":["Bash","Edit"]}', 'Read'],
    ['empty', '{\n  "d": []\n}\n', 'Read'],
    ['a trailing comma', '{\n  "d": [\n    "Bash",\n  ]\n}\n', 'Read'],
    ['a comment', '{\n  "d": [\n    "Bash" // why\n  ]\n}\n', 'Read'],
  ])('array: %s', (_n, text, item) => {
    roundTrip(text, ['d'], undefined, item);
  });

  it('writes a multi-line member in the file style', () => {
    expect(append('{\n  "a": 1\n}\n', [], 'b', { c: [1] }, styleOf('{\n  "a": 1\n}\n'))).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": [\n      1\n    ]\n  }\n}\n',
    );
    expect(append('{}', [], 'b', 1, styleOf('{}'))).toBe('{\n  "b": 1\n}');
    expect(append('{\n  "d": ["Bash"]\n}', ['d'], undefined, 'Read', styleOf('{\n'))).toBe(
      '{\n  "d": ["Bash", "Read"]\n}',
    );
  });

  it('removes several appended members in any order', () => {
    const t = '{\n  "d": ["A"],\n  "k": 1\n}\n';
    const s = styleOf(t);
    let o = append(t, ['d'], undefined, 'B', s);
    o = append(o, ['d'], undefined, 'C', s);
    o = append(o, [], 'n', { x: 1 }, s);
    o = remove(o, ['d', 1]);
    o = remove(o, ['n']);
    o = remove(o, ['d', 1]);
    expect(o).toBe(t);
  });

  it('appends to an empty multi-line object; removal leaves it {} (whitespace only differs)', () => {
    const t = '{\n  "a": {\n  }\n}\n';
    const o = append(t, ['a'], 'b', 1, styleOf(t));
    expect(o).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
    expect(remove(o, ['a', 'b'])).toBe('{\n  "a": {}\n}\n');
  });

  it('empties a container to {} or [] when its only member goes', () => {
    expect(remove('{\n  "a": 1\n}', ['a'])).toBe('{}');
    expect(remove('{"a":[1]}', ['a', 0])).toBe('{"a":[]}');
    expect(remove('{\n  // c\n  "a": 1\n}', ['a'])).toBe('{\n  // c\n}');
  });
});
