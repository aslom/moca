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
import { afterEach, describe, expect, it, vi } from 'vitest';

// The guard in agent-config's edits: an append whose result parses but does not hold the intended
// value (an edit that landed in a comment, say) is refused, and nothing is written.
vi.mock('../src/sbx/json-edit.js', async (orig) => {
  const real = await orig<typeof import('../src/sbx/json-edit.js')>();
  return {
    ...real,
    // Appends something else: the document still parses, but the intended member is not in it
    // (as when an append lands inside a comment).
    append: (text: string, path: string[], key: string | undefined, _v: unknown, st: never) =>
      real.append(text, path, key === undefined ? undefined : `${key}-misplaced`, 0, st),
  };
});

const { ConfigConflict, writeAgentConfig } = await import('../src/sbx/agent-config.js');

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the edit guard', () => {
  it('refuses an edit that does not produce the intended value, writing nothing', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-guard-')));
    made.push(d);
    mkdirSync(join(d, '.git'));
    const body = '{\n  "model": "x"\n}\n';
    writeFileSync(join(d, 'opencode.json'), body);
    let err: unknown;
    try {
      writeAgentConfig(d);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigConflict);
    expect((err as InstanceType<typeof ConfigConflict>).message).toMatch(
      /could not be edited safely/,
    );
    expect(readFileSync(join(d, 'opencode.json'), 'utf8')).toBe(body);
    expect(existsSync(join(d, '.mcp.json'))).toBe(false);
    expect(existsSync(join(d, '.sbx'))).toBe(false);
  });
});
