import { expect, test } from '@playwright/test';
import { verifySignature } from '../../src/webhooks/sign.js';
import { resetE2eDatabase, startApp, startFixtureSite, startReceiver } from './support.js';

const SECRET = 'e2e-secret';

interface Change {
  id: string;
  monitorId: string;
  status: string;
  meaningful: boolean | null;
  category: string | null;
  severity: string | null;
  summary: string | null;
  webhookDelivered: boolean;
}

test.describe.serial('monitor -> change -> classification -> signed webhook', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  test.beforeAll(async () => {
    await resetE2eDatabase();
    site = await startFixtureSite();
    receiver = await startReceiver();
    app = await startApp({
      LLM_PROVIDER: 'mock',
      ALLOW_PRIVATE_HOSTS: 'true',
      FETCH_MODE: 'auto',
      WEBHOOK_SECRET: SECRET,
      WORKER_POLL_MS: '100',
      SCHEDULER_POLL_MS: '200',
      BACKOFF_BASE_MS: '100',
      BACKOFF_CAP_MS: '500',
    });
  });

  test.afterAll(async () => {
    await app?.stop();
    await site?.close();
    await receiver?.close();
  });

  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${app.url}${path}`, { ...init, headers: init?.body ? { 'content-type': 'application/json' } : {} });
    expect(res.ok, `${init?.method ?? 'GET'} ${path} -> ${res.status}`).toBe(true);
    return (await res.json()) as T;
  };

  async function addMonitor(pagePath: string, name: string): Promise<string> {
    const monitor = await api<{ id: string }>('/monitors', {
      method: 'POST',
      body: JSON.stringify({ url: `${site.url}${pagePath}`, name, webhookUrl: `${receiver.url}/hook`, intervalSeconds: 3600 }),
    });
    // The scheduler picks the new monitor up immediately; wait for the baseline snapshot.
    await expect.poll(async () => (await api<{ id: string; lastCheckedAt: string | null }[]>('/monitors')).find((m) => m.id === monitor.id)?.lastCheckedAt, { timeout: 20_000 }).not.toBeNull();
    return monitor.id;
  }

  const checkNow = (id: string) => api(`/monitors/${id}/check`, { method: 'POST' });
  const changesFor = async (id: string) => (await api<Change[]>(`/changes?monitorId=${id}`));

  test('a price change is detected, classified and delivered with a valid signature', async () => {
    const id = await addMonitor('/', 'Console price');
    expect(await changesFor(id)).toHaveLength(0); // baseline is not a change

    site.state.price = '$14';
    await checkNow(id);

    await expect.poll(async () => (await changesFor(id))[0]?.status, { timeout: 20_000 }).toBe('classified');
    const change = (await changesFor(id))[0]!;
    expect(change).toMatchObject({ meaningful: true, category: 'price', severity: 'high' });

    await expect.poll(() => receiver.received.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    const request = receiver.received.find((r) => (JSON.parse(r.body) as { watchdog: { changeId: string } }).watchdog.changeId === change.id)!;
    expect(request).toBeDefined();
    expect(verifySignature(SECRET, request.headers['x-watchdog-signature'] as string, request.headers['x-watchdog-timestamp'] as string, request.body)).toBe(true);
    expect(verifySignature('wrong-secret', request.headers['x-watchdog-signature'] as string, request.headers['x-watchdog-timestamp'] as string, request.body)).toBe(false);
    const payload = JSON.parse(request.body) as { text: string; watchdog: Record<string, string> };
    expect(payload.watchdog).toMatchObject({ category: 'price', monitorName: 'Console price' });
    expect(payload.text).toContain('Console price');

    await expect.poll(async () => (await changesFor(id))[0]?.webhookDelivered).toBe(true);
  });

  test('a repeated check of unchanged content sends nothing new', async () => {
    const id = await addMonitor('/', 'Console again');
    const before = receiver.received.length;
    await checkNow(id);
    await checkNow(id);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await changesFor(id)).toHaveLength(0);
    expect(receiver.received.length).toBe(before);
  });

  test('a timestamp-only change is filtered as noise and triggers no webhook', async () => {
    const id = await addMonitor('/clock', 'Status clock');
    const before = receiver.received.length;
    site.state.clock = '2026-03-03 10:07:31';
    await checkNow(id);

    await expect.poll(async () => (await changesFor(id))[0]?.status, { timeout: 20_000 }).toBe('filtered_noise');
    await new Promise((r) => setTimeout(r, 1000));
    expect(receiver.received.length).toBe(before);
  });

  test('changes in JavaScript-rendered content are seen (Playwright fetch path)', async () => {
    const id = await addMonitor('/js', 'JS pricing');
    site.state.jsPrice = '$149';
    await checkNow(id);
    await expect.poll(async () => (await changesFor(id))[0]?.status, { timeout: 20_000 }).toBe('classified');
    expect((await changesFor(id))[0]).toMatchObject({ category: 'price' });
  });

  test('the dashboard lists monitors and recent changes', async ({ page }) => {
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: 'Website Watchdog' })).toBeVisible();
    await expect(page.locator('#monitors')).toContainText('Console price');
    await expect(page.locator('#changes')).toContainText('price');
    await expect(page.locator('#changes')).toContainText('sent');
  });
});
