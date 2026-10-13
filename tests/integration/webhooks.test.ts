import { afterEach, expect, it } from 'vitest';
import { deliverWebhook } from '../../src/webhooks/deliver.js';
import { verifySignature } from '../../src/webhooks/sign.js';
import { PermanentError, RetryLaterError } from '../../src/queue/errors.js';
import { enqueue } from '../../src/queue/queue.js';
import { Worker } from '../../src/queue/worker.js';
import { logger } from '../../src/logger.js';
import { createHandlers } from '../../src/jobs/handlers.js';
import { MockProvider } from '../../src/llm/mock.js';
import { HttpFetcher } from '../../src/fetch/http-fetcher.js';
import type { Db } from '../../src/db/pool.js';
import { describeDb, seedMonitor, startReceiver, useTestDb } from './helpers.js';

const SECRET = 'test-secret';

async function seedChange(db: Db, webhookUrl: string | null): Promise<string> {
  const monitorId = await seedMonitor(db, { webhookUrl });
  const snap = async (hash: string) =>
    (await db.query<{ id: string }>("INSERT INTO snapshots (monitor_id, content_hash, text, fetch_method) VALUES ($1, $2, 't', 'http') RETURNING id", [monitorId, hash])).rows[0]!.id;
  const [prev, next] = [await snap('h1'), await snap('h2')];
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO changes (monitor_id, previous_snapshot_id, snapshot_id, added, removed, status, meaningful, category, severity, summary, classified_at)
     VALUES ($1, $2, $3, '[]', '[]', 'classified', true, 'price', 'high', 'Price rose from $29 to $39', now()) RETURNING id`,
    [monitorId, prev, next],
  );
  return rows[0]!.id;
}

describeDb('webhook delivery (real Postgres + local receiver)', () => {
  const { db } = useTestDb();
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });
  const receiver = async (...args: Parameters<typeof startReceiver>) => {
    const r = await startReceiver(...args);
    closers.push(r.close);
    return r;
  };
  const deps = () => ({ db: db(), secret: SECRET });
  const logRows = async () => (await db().query('SELECT outcome, status_code, attempt FROM webhook_deliveries ORDER BY id')).rows;

  it('sends a correctly signed, timestamped request and logs the delivery', async () => {
    const r = await receiver();
    const changeId = await seedChange(db(), r.url);

    expect(await deliverWebhook(deps(), changeId, 1)).toBe('sent');

    expect(r.received).toHaveLength(1);
    const { headers, body } = r.received[0]!;
    expect(verifySignature(SECRET, headers['x-watchdog-signature'] as string, headers['x-watchdog-timestamp'] as string, body)).toBe(true);
    expect(verifySignature('wrong', headers['x-watchdog-signature'] as string, headers['x-watchdog-timestamp'] as string, body)).toBe(false);
    expect(headers['x-watchdog-delivery']).toBe(changeId);
    expect(JSON.parse(body)).toMatchObject({ watchdog: { changeId, category: 'price', severity: 'high' } });
    expect(await logRows()).toEqual([{ outcome: 'success', status_code: 200, attempt: 1 }]);
  });

  it('does not send a second time for the same change', async () => {
    const r = await receiver();
    const changeId = await seedChange(db(), r.url);
    expect(await deliverWebhook(deps(), changeId, 1)).toBe('sent');
    expect(await deliverWebhook(deps(), changeId, 2)).toBe('already_sent');
    expect(r.received).toHaveLength(1);
  });

  it('can never record two successful deliveries, even when two workers race', async () => {
    const r = await receiver();
    const changeId = await seedChange(db(), r.url);
    await Promise.allSettled([deliverWebhook(deps(), changeId, 1), deliverWebhook(deps(), changeId, 1)]);
    const successes = (await logRows()).filter((row) => row.outcome === 'success');
    expect(successes).toHaveLength(1);
  });

  it('enqueuing the webhook job twice for one change creates one job', async () => {
    const changeId = await seedChange(db(), null);
    const key = `webhook:${changeId}`;
    expect(await enqueue(db(), { type: 'deliver_webhook', payload: { changeId }, idempotencyKey: key })).not.toBeNull();
    expect(await enqueue(db(), { type: 'deliver_webhook', payload: { changeId }, idempotencyKey: key })).toBeNull();
  });

  it('throws a retryable error on 5xx and logs the failed attempt', async () => {
    const r = await receiver(() => ({ status: 503 }));
    const changeId = await seedChange(db(), r.url);
    await expect(deliverWebhook(deps(), changeId, 1)).rejects.toThrow(/503/);
    expect(await logRows()).toEqual([{ outcome: 'failure', status_code: 503, attempt: 1 }]);
  });

  it('uses Retry-After on 429 and gives up immediately on other 4xx', async () => {
    const limited = await receiver(() => ({ status: 429, headers: { 'retry-after': '12' } }));
    await expect(deliverWebhook(deps(), await seedChange(db(), limited.url), 1)).rejects.toMatchObject({ retryAfterMs: 12_000 });
    await expect(deliverWebhook(deps(), await seedChange(db(), limited.url), 1)).rejects.toBeInstanceOf(RetryLaterError);

    const gone = await receiver(() => ({ status: 410 }));
    await expect(deliverWebhook(deps(), await seedChange(db(), gone.url), 1)).rejects.toBeInstanceOf(PermanentError);
  });

  it('treats a network error as a retryable failure', async () => {
    const changeId = await seedChange(db(), 'http://127.0.0.1:1/hook'); // nothing listens on port 1
    await expect(deliverWebhook({ ...deps(), timeoutMs: 1000 }, changeId, 1)).rejects.toThrow(/Webhook request failed/);
    expect((await logRows())[0]).toMatchObject({ outcome: 'failure', status_code: null });
  });

  it('retries via the queue and dead-letters after the configured number of attempts', async () => {
    const r = await receiver(() => ({ status: 500 }));
    const changeId = await seedChange(db(), r.url);
    await enqueue(db(), { type: 'deliver_webhook', payload: { changeId }, idempotencyKey: `webhook:${changeId}`, maxAttempts: 3 });

    const worker = new Worker({
      db: db(),
      log: logger,
      backoff: { baseMs: 0, capMs: 0 },
      handlers: createHandlers({
        db: db(),
        config: { defaultWebhookUrl: undefined, webhookSecret: SECRET, webhookMaxAttempts: 3 },
        fetcher: new HttpFetcher(),
        llm: new MockProvider(),
        log: logger,
      }),
    });
    while (await worker.runOnce()) {
      /* drain */
    }

    expect(r.received).toHaveLength(3);
    expect((await db().query("SELECT status, attempts FROM jobs")).rows).toEqual([{ status: 'dead', attempts: 3 }]);
    expect((await logRows()).map((row) => row.outcome)).toEqual(['failure', 'failure', 'failure']);
  });

  it('skips quietly when neither the monitor nor the environment has a webhook URL', async () => {
    const changeId = await seedChange(db(), null);
    expect(await deliverWebhook(deps(), changeId, 1)).toBe('no_destination');
  });

  it('falls back to the default webhook URL', async () => {
    const r = await receiver();
    const changeId = await seedChange(db(), null);
    expect(await deliverWebhook({ ...deps(), defaultWebhookUrl: r.url }, changeId, 1)).toBe('sent');
  });
});
