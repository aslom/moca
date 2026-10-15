import {
  estimateTokens,
  shouldCompact,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';

type CompactionSettings = ReturnType<SettingsManager['getCompactionSettings']>;

type Msg = Parameters<typeof estimateTokens>[0];

/**
 * Pi decides on compaction AFTER a reply, against the active model's window, and on an overflow
 * error compacts and retries. After a switch to a smaller model (per-session model spec §5.3) the
 * next request could therefore be sent knowing it cannot fit. This is the check before it: the
 * loaded history, estimated as pi estimates it (chars/4), against the CURRENT model's window.
 * It does not depend on a switch having happened, so no "previous window" is stored anywhere.
 */
export function promptWouldOverflow(
  messages: Msg[],
  contextWindow: number | undefined,
  settings: CompactionSettings,
): boolean {
  if (!contextWindow || messages.length === 0) return false;
  const tokens = messages.reduce((n, m) => n + estimateTokens(m), 0);
  return shouldCompact(tokens, contextWindow, settings);
}

export interface CompactableSession {
  messages: Msg[];
  model?: { contextWindow?: number };
  settingsManager: { getCompactionSettings(): CompactionSettings };
  compact(): Promise<unknown>;
}

/**
 * Compact first when the prompt would not fit. A failure (pi refuses a history too small to cut)
 * is logged and the turn proceeds: pi's own overflow path is still behind it.
 */
export async function compactIfOverflowing(session: CompactableSession): Promise<boolean> {
  const settings = session.settingsManager.getCompactionSettings();
  if (!promptWouldOverflow(session.messages, session.model?.contextWindow, settings)) return false;
  try {
    await session.compact();
    return true;
  } catch (err) {
    console.error(
      `[compaction] pre-prompt compaction failed; the turn proceeds: ${(err as Error)?.message ?? String(err)}`,
    );
    return false;
  }
}
