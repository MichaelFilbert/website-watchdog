import { describe, expect, it } from 'vitest';
import { filterNoise, maskVolatile } from '../../src/text/noise.js';

const diff = (removed: string[], added: string[]) => ({ removed, added });

describe('maskVolatile', () => {
  it.each([
    ['Updated 2026-03-03T14:05:11Z', 'Updated 2026-03-04T09:00:00Z'],
    ['Posted 5 minutes ago', 'Posted 6 minutes ago'],
    ['1,204 people viewing', '1,311 people viewing'],
    ['Clock 2:05 PM EST', 'Clock 2:06 PM EST'],
    ['Session 9f86d081884c7d659a2feaa0c55ad015', 'Session a3f5d081884c7d659a2feaa0c55ad099'],
    ['(c) 2025 Acme', '(c) 2026 Acme'],
  ])('maps %s and %s to the same string', (a, b) => {
    expect(maskVolatile(a)).toBe(maskVolatile(b));
  });

  it('does not mask prices or stock words', () => {
    expect(maskVolatile('Now $24.90')).not.toBe(maskVolatile('Now $19.90'));
    expect(maskVolatile('In stock')).not.toBe(maskVolatile('Out of stock'));
  });
});

describe('filterNoise', () => {
  it('flags a pure timestamp change as noise', () => {
    const v = filterNoise(diff(['Last updated: 2026-03-03 14:05:11'], ['Last updated: 2026-03-03 14:06:42']));
    expect(v.isNoise).toBe(true);
  });

  it('flags counters and ad slots as noise', () => {
    expect(filterNoise(diff(['Views: 10'], ['Views: 99'])).isNoise).toBe(true);
    expect(filterNoise(diff(['Sponsored: Buy A'], ['Sponsored: Buy B'])).isNoise).toBe(true);
  });

  it('keeps a real price change even when a timestamp changed in the same diff', () => {
    const v = filterNoise(diff(['Price $29', 'Updated 5 minutes ago'], ['Price $39', 'Updated 6 minutes ago']));
    expect(v.isNoise).toBe(false);
    expect(v.added).toEqual(['Price $39']);
    expect(v.removed).toEqual(['Price $29']);
  });

  it('does not let an unrelated new line hide behind a timestamp change', () => {
    const v = filterNoise(diff(['Updated 5 minutes ago'], ['Updated 6 minutes ago', 'We are closing down all stores.']));
    expect(v.isNoise).toBe(false);
    expect(v.added).toEqual(['We are closing down all stores.']);
  });

  it('treats an empty diff as noise', () => {
    expect(filterNoise(diff([], [])).isNoise).toBe(true);
  });
});
