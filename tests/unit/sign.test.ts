import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../../src/webhooks/sign.js';
import { buildWebhookBody } from '../../src/webhooks/payload.js';

const secret = 'topsecret';
const body = JSON.stringify({ hello: 'world' });
const now = 1_800_000_000;

describe('webhook signing', () => {
  it('produces a stable sha256= signature', () => {
    const sig = signPayload(secret, now, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload(secret, now, body)).toBe(sig);
  });

  it('verifies a valid signature', () => {
    expect(verifySignature(secret, signPayload(secret, now, body), String(now), body, { nowSeconds: now + 5 })).toBe(true);
  });

  it('rejects a tampered body, wrong secret, or wrong timestamp', () => {
    const sig = signPayload(secret, now, body);
    expect(verifySignature(secret, sig, String(now), body + ' ', { nowSeconds: now })).toBe(false);
    expect(verifySignature('other', sig, String(now), body, { nowSeconds: now })).toBe(false);
    expect(verifySignature(secret, sig, String(now + 1), body, { nowSeconds: now })).toBe(false);
  });

  it('rejects old timestamps (replay protection) and missing headers', () => {
    const sig = signPayload(secret, now, body);
    expect(verifySignature(secret, sig, String(now), body, { nowSeconds: now + 301 })).toBe(false);
    expect(verifySignature(secret, undefined, String(now), body, { nowSeconds: now })).toBe(false);
    expect(verifySignature(secret, sig, undefined, body, { nowSeconds: now })).toBe(false);
    expect(verifySignature(secret, sig, 'not-a-number', body, { nowSeconds: now })).toBe(false);
  });

  it('builds a body usable by Slack (text) and Discord (content)', () => {
    const parsed = JSON.parse(
      buildWebhookBody({ changeId: 'c1', monitorName: 'Shop', url: 'https://x.test', category: 'price', severity: 'high', summary: 'Up 20%', detectedAt: 'now' }),
    ) as Record<string, unknown>;
    expect(parsed.text).toBe(parsed.content);
    expect(String(parsed.text)).toContain('Up 20%');
    expect(parsed.watchdog).toMatchObject({ changeId: 'c1' });
  });
});
