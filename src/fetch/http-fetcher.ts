import { htmlToText } from '../text/html.js';
import { PermanentError, RetryLaterError } from '../queue/errors.js';
import { parseRetryAfterMs } from '../llm/anthropic.js';
import type { FetchedPage, PageFetcher } from './types.js';

const MAX_BYTES = 2_000_000;

/** The monitored site answered with a server-side failure; retryable, but a different client will not help. */
export class SiteError extends Error {
  override name = 'SiteError';
}

/** Maps an HTTP status from the monitored site onto "retry later", "retry" or "give up". */
export function throwForStatus(status: number, retryAfter: string | null): void {
  if (status < 400) return;
  if (status === 429) throw new RetryLaterError('Site rate limited us (429)', parseRetryAfterMs(retryAfter) ?? 60_000);
  if (status >= 500 || status === 408) throw new SiteError(`Site returned HTTP ${status}`);
  throw new PermanentError(`Site returned HTTP ${status}`);
}

export class HttpFetcher implements PageFetcher {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async fetch(url: string): Promise<FetchedPage> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'user-agent': 'website-watchdog/0.1 (+monitoring)', accept: 'text/html,*/*;q=0.8' },
      });
    } catch (err) {
      throw new Error(`Fetch failed: ${(err as Error).message}`, { cause: err });
    }
    throwForStatus(res.status, res.headers.get('retry-after'));
    const body = (await res.text()).slice(0, MAX_BYTES);
    const type = res.headers.get('content-type') ?? '';
    return { text: type.includes('html') ? htmlToText(body) : body, method: 'http' };
  }

  async close(): Promise<void> {}
}
