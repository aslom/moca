import { Text } from 'ink';
import { useEffect, useState } from 'react';
import type { ModelList } from '../../api/types.js';
import { describeError } from '../../core/messages.js';
import { sanitizeRemote } from '../../core/sanitize.js';
import { SelectList } from '../SelectList.js';
import { Spinner } from '../Spinner.js';

interface Props {
  load: () => Promise<ModelList>;
  /** The session's model; null on the deployment default. */
  current: string | null;
  onSelect: (id: string | null) => void;
  onCancel: () => void;
  /** True when the error was handled (a login opened); the overlay then shows nothing of it. */
  onError: (err: unknown) => boolean;
  /** Reports the screens with no input (loading, an error), so the App's Esc closes them. */
  onInputless?: (inputless: boolean) => void;
}

/** `/model` (per-session model spec §6): the session credential's models, the current one marked. */
export function ModelOverlay({ load, current, onSelect, onCancel, onError, onInputless }: Props) {
  const [list, setList] = useState<ModelList>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let live = true;
    load().then(
      (l) => live && setList(l),
      (err: unknown) => {
        if (live && !onError(err)) setFailed(describeError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const inputless = !!failed || !list;
  useEffect(() => {
    onInputless?.(inputless);
  }, [inputless]);

  if (failed) {
    return (
      <Text>
        {sanitizeRemote(failed)} — switch by name with /model {'<id>'} (Esc to close)
      </Text>
    );
  }
  if (!list) return <Spinner label="loading models…" />;
  const mark = (id: string | null) => (id === current ? 'current' : undefined);
  return (
    <SelectList<string | null>
      title={`Model — ${sanitizeRemote(list.credential)}`}
      filter="always"
      initialKey={current ?? '__default__'}
      items={[
        { key: '__default__', label: 'deployment default', detail: mark(null), value: null },
        ...list.models.map((m) => ({
          key: m.id,
          label: sanitizeRemote(m.id),
          detail: [m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : '', mark(m.id)]
            .filter(Boolean)
            .join('  '),
          value: m.id,
        })),
      ]}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}
