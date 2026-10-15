import { describe, expect, it } from 'vitest';
import { MODEL_ID_RE, sanitizeLimits } from '../src/models.js';
import { CP_ERROR_CODES, statusFor } from '../src/errors.js';

describe('MODEL_ID_RE', () => {
  it.each([
    'claude-opus-4-8',
    'meta-llama/Llama-3.1-8B-Instruct',
    'bedrock/anthropic.claude-3:0',
    'granite-4.1-8b',
  ])('accepts %s', (id) => expect(MODEL_ID_RE.test(id)).toBe(true));

  it.each(['', 'has space', 'tab\there', 'x'.repeat(257), 'naïve'])('refuses %j', (id) =>
    expect(MODEL_ID_RE.test(id)).toBe(false),
  );
});

describe('sanitizeLimits', () => {
  it('keeps known fields of the right type and drops the rest', () => {
    expect(
      sanitizeLimits({
        contextWindow: 200000,
        maxTokens: 32000,
        reasoning: true,
        vision: false,
        cost: 3,
      }),
    ).toEqual({ contextWindow: 200000, maxTokens: 32000, reasoning: true, vision: false });
  });

  it('drops non-positive and non-integer numbers, and wrongly typed booleans', () => {
    expect(sanitizeLimits({ contextWindow: -1, maxTokens: 1.5, reasoning: 'yes' })).toBeUndefined();
  });

  it('is undefined for anything that is not an object', () => {
    expect(sanitizeLimits(null)).toBeUndefined();
    expect(sanitizeLimits('x')).toBeUndefined();
    expect(sanitizeLimits([1])).toBeUndefined();
  });
});

describe('model error codes', () => {
  it('are in the taxonomy with their statuses', () => {
    expect(CP_ERROR_CODES).toContain('model_unavailable');
    expect(CP_ERROR_CODES).toContain('model_catalog_unavailable');
    expect(statusFor('model_unavailable')).toBe(400);
    expect(statusFor('model_catalog_unavailable')).toBe(503);
  });
});
