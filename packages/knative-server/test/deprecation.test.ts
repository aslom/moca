import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  KNATIVE_DEPRECATION_NOTICE,
  runningUnderKnative,
  warnKnativeDeprecation,
} from '../src/deprecation.js';

describe('runningUnderKnative (ADR-0041)', () => {
  it('detects each env var Knative Serving injects, singly', () => {
    expect(runningUnderKnative({ K_SERVICE: 'moca' })).toBe(true);
    expect(runningUnderKnative({ K_CONFIGURATION: 'moca' })).toBe(true);
    expect(runningUnderKnative({ K_REVISION: 'moca-00001' })).toBe(true);
  });

  it('stays silent off the Knative path — the P6 supervisor forks worker.ts without Knative env', () => {
    expect(runningUnderKnative({})).toBe(false);
    expect(
      runningUnderKnative({ HOSTNAME: 'worker-1', PORT: '8080', REDIS_URL: 'redis://redis:6379' }),
    ).toBe(false);
  });
});

describe('warnKnativeDeprecation (ADR-0041)', () => {
  it('prints the canonical notice once, under Knative', () => {
    const warn = vi.fn();
    expect(warnKnativeDeprecation({ K_SERVICE: 'moca' }, warn)).toBe(KNATIVE_DEPRECATION_NOTICE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(KNATIVE_DEPRECATION_NOTICE);
  });

  it('prints nothing off the Knative path', () => {
    const warn = vi.fn();
    expect(warnKnativeDeprecation({}, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('KNATIVE_DEPRECATION_NOTICE carries the ADR-0041 policy verbatim', () => {
  it('names the ADR, the removal floor and the migration guide', () => {
    expect(KNATIVE_DEPRECATION_NOTICE).toContain('ADR-0041');
    expect(KNATIVE_DEPRECATION_NOTICE).toContain('end of October 2026');
    expect(KNATIVE_DEPRECATION_NOTICE).toContain('docs/migrating-from-knative.md');
  });
});

describe('server.ts wiring (ADR-0041)', () => {
  const serverSrc = readFileSync(
    fileURLToPath(new URL('../src/server.ts', import.meta.url)),
    'utf8',
  );
  const workerSrc = readFileSync(
    fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
    'utf8',
  );

  it('startServer warns under Knative, before the shared boot call', () => {
    // Anchored to start-of-line, as worker-boot.test.ts does for prepareServerProcess: server.ts
    // must not be able to satisfy this with a comment that names the call.
    const warn = /^\s*warnKnativeDeprecation\(process\.env\);/m.exec(serverSrc);
    const boot = serverSrc.indexOf('prepareServerProcess(process.env)');
    expect(warn).not.toBeNull();
    expect(boot).toBeGreaterThan(-1);
    expect(warn!.index).toBeLessThan(boot);
  });

  it('the P6 worker never imports the warning — supervisor-forked workers stay silent', () => {
    expect(workerSrc).not.toMatch(/deprecation\.js/);
  });
});
