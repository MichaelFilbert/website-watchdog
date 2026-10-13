import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-watchdog-signature';
export const TIMESTAMP_HEADER = 'x-watchdog-timestamp';
export const DELIVERY_HEADER = 'x-watchdog-delivery';

/**
 * Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`), hex, prefixed "sha256=".
 * The timestamp is part of the signed string so a captured request cannot be
 * replayed later with a fresh timestamp.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface VerifyOptions {
  /** Max accepted age of the timestamp, either direction. Default 5 minutes. */
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/** Receiver-side check, also used by the tests. Constant-time comparison. */
export function verifySignature(
  secret: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  body: string,
  { toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000) }: VerifyOptions = {},
): boolean {
  if (!signatureHeader || !timestampHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
