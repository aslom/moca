import { describe, expect, it, vi } from 'vitest';
import { compactIfOverflowing, promptWouldOverflow } from '../src/pre-prompt-compaction';

// estimateTokens is chars/4: 16 000 characters is about 4 000 tokens.
const big = [{ role: 'user', content: 'x'.repeat(16_000), timestamp: 0 }] as never[];
const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 };

describe('promptWouldOverflow', () => {
  it('is true when the history leaves less than reserveTokens of the window', () => {
    expect(promptWouldOverflow(big, 4_500, settings)).toBe(true);
  });

  it('is false when it fits', () => {
    expect(promptWouldOverflow(big, 10_000, settings)).toBe(false);
  });

  it('is false with compaction disabled, no window, or no history', () => {
    expect(promptWouldOverflow(big, 4_500, { ...settings, enabled: false })).toBe(false);
    expect(promptWouldOverflow(big, undefined, settings)).toBe(false);
    expect(promptWouldOverflow([], 4_500, settings)).toBe(false);
  });
});

describe('compactIfOverflowing', () => {
  const session = (contextWindow: number, compact = vi.fn(async () => ({}))) => ({
    messages: big,
    model: { contextWindow },
    settingsManager: { getCompactionSettings: () => settings },
    compact,
  });

  it('compacts when the next prompt would not fit', async () => {
    const s = session(4_500);
    expect(await compactIfOverflowing(s)).toBe(true);
    expect(s.compact).toHaveBeenCalledOnce();
  });

  it('leaves a history that fits alone', async () => {
    const s = session(10_000);
    expect(await compactIfOverflowing(s)).toBe(false);
    expect(s.compact).not.toHaveBeenCalled();
  });

  it('lets the turn proceed when compaction fails', async () => {
    const s = session(
      4_500,
      vi.fn(async () => {
        throw new Error('Nothing to compact (session too small)');
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await compactIfOverflowing(s)).toBe(false);
  });
});
