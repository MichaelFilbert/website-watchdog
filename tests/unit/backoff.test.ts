import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../../src/queue/backoff.js';

const opts = { baseMs: 1000, capMs: 60_000 };

describe('backoffDelayMs (full jitter)', () => {
  it('doubles the ceiling each attempt', () => {
    const max = () => 0.999999;
    expect(backoffDelayMs(1, opts, max)).toBeLessThan(1000);
    expect(backoffDelayMs(2, opts, max)).toBeLessThan(2000);
    expect(backoffDelayMs(3, opts, max)).toBeLessThan(4000);
    expect(backoffDelayMs(3, opts, max)).toBeGreaterThan(3900);
  });

  it('never exceeds the cap', () => {
    expect(backoffDelayMs(30, opts, () => 0.999999)).toBeLessThanOrEqual(60_000);
  });

  it('is jittered: the same attempt gives different delays for different random draws', () => {
    expect(backoffDelayMs(4, opts, () => 0.1)).not.toBe(backoffDelayMs(4, opts, () => 0.9));
    expect(backoffDelayMs(4, opts, () => 0)).toBe(0);
  });
});
