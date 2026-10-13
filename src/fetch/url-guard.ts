import { isIP } from 'node:net';

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./];

/**
 * Basic SSRF guard for user-supplied URLs: only http(s), and no obviously internal hosts
 * unless explicitly allowed. This checks the hostname text only; it does not resolve DNS,
 * so a public name that points at a private IP would get through (documented limitation).
 */
export function validateMonitorUrl(raw: string, allowPrivateHosts: boolean): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'only http and https URLs are allowed' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  if (!allowPrivateHosts) {
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const internal =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      host === '::1' ||
      host.startsWith('fc') && isIP(host) === 6 ||
      host.startsWith('fd') && isIP(host) === 6 ||
      (isIP(host) === 4 && PRIVATE_V4.some((re) => re.test(host)));
    if (internal) return { ok: false, reason: 'private and loopback hosts are not allowed' };
  }
  return { ok: true, url: parsed.toString() };
}
