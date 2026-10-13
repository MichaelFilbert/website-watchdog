import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { throwForStatus } from './http-fetcher.js';
import type { FetchedPage, PageFetcher } from './types.js';

/** Renders the page in headless Chromium so JavaScript-built content is included. */
export class PlaywrightFetcher implements PageFetcher {
  private browser?: Promise<Browser>;

  constructor(private readonly timeoutMs = 30_000) {}

  private getBrowser(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true }).catch((err: unknown) => {
      this.browser = undefined; // allow a later retry after e.g. `playwright install`
      throw err;
    });
    return this.browser;
  }

  async fetch(url: string): Promise<FetchedPage> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ userAgent: 'website-watchdog/0.1 (+monitoring)' });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'load', timeout: this.timeoutMs });
      if (response) throwForStatus(response.status(), response.headers()['retry-after'] ?? null);
      // Give client-side rendering a moment, but never block on pages that poll forever.
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      const text = await page.evaluate(() => document.body?.innerText ?? '');
      return { text, method: 'playwright' };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close();
    this.browser = undefined;
  }
}
