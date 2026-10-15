import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ModelOverlay } from '../src/views/overlays/Model.js';
import { KEY, inputReady, waitFor, withTheme } from './helpers/ink.js';

const list = async () => ({
  credential: 'litellm-prod',
  models: [{ id: 'claude-opus-4-8', contextWindow: 200000 }, { id: 'granite-4.1-8b' }],
});

describe('ModelOverlay', () => {
  it('lists the deployment default and the models, marking the current one', async () => {
    const { lastFrame, stdin } = render(
      withTheme(
        <ModelOverlay
          load={list}
          current="granite-4.1-8b"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('granite') && inputReady(stdin), 1000, lastFrame);
    expect(lastFrame()).toContain('deployment default');
    expect(lastFrame()).toContain('claude-opus-4-8');
    expect(lastFrame()).toMatch(/granite-4\.1-8b.*current/);
  });

  it('selects a model on enter, and null for the default', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      withTheme(
        <ModelOverlay load={list} current={null} onSelect={onSelect} onCancel={vi.fn()} onError={() => false} />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('granite') && inputReady(stdin), 1000, lastFrame);
    stdin.write(KEY.enter);
    await waitFor(() => onSelect.mock.calls.length > 0, 1000, lastFrame);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('shows why when the catalog cannot be read', async () => {
    const { lastFrame } = render(
      withTheme(
        <ModelOverlay
          load={async () => {
            throw new Error('the inference endpoint could not list models');
          }}
          current={null}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('could not list'), 1000, lastFrame);
    expect(lastFrame()).toContain('/model <id>');
  });
});
