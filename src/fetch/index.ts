import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { HttpFetcher, SiteError } from './http-fetcher.js';
import { PlaywrightFetcher } from './playwright-fetcher.js';
import { PermanentError, RetryLaterError } from '../queue/errors.js';
import type { FetchedPage, PageFetcher } from './types.js';

/**
 * Playwright first; if the browser itself cannot run (not installed, crashed on launch),
 * fall back to a plain fetch. Errors that are about the *site* (4xx/5xx, rate limits)
 * are not worth a second attempt with a different client and are rethrown as-is.
 */
export class FallbackFetcher implements PageFetcher {
  constructor(
    private readonly primary: PageFetcher,
    private readonly fallback: PageFetcher,
    private readonly log: Logger,
  ) {}

  async fetch(url: string): Promise<FetchedPage> {
    try {
      return await this.primary.fetch(url);
    } catch (err) {
      if (err instanceof PermanentError || err instanceof RetryLaterError || err instanceof SiteError) throw err;
      this.log.warn({ url, err: (err as Error).message }, 'rendered fetch failed; falling back to plain HTTP');
      return this.fallback.fetch(url);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }
}

export function createFetcher(config: Config, log: Logger): PageFetcher {
  if (config.fetchMode === 'http') return new HttpFetcher();
  if (config.fetchMode === 'playwright') return new PlaywrightFetcher();
  return new FallbackFetcher(new PlaywrightFetcher(), new HttpFetcher(), log);
}
