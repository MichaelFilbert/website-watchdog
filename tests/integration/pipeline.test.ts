import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import type { Db } from '../../src/db/pool.js';
import { checkMonitor, classifyChange, createHandlers } from '../../src/jobs/handlers.js';
import type { HandlerDeps } from '../../src/jobs/handlers.js';
import { scheduleDueChecks } from '../../src/jobs/scheduler.js';
import { logger } from '../../src/logger.js';
import { MockProvider } from '../../src/llm/mock.js';
import { LlmError } from '../../src/llm/types.js';
import type { LlmProvider } from '../../src/llm/types.js';
import type { FetchedPage, PageFetcher } from '../../src/fetch/types.js';
import { claimJob } from '../../src/queue/queue.js';
import type { Job } from '../../src/queue/queue.js';
import { Worker } from '../../src/queue/worker.js';
import { describeDb, seedMonitor, useTestDb } from './helpers.js';

class FakeFetcher implements PageFetcher {
  constructor(public text: string) {}
  fetch(): Promise<FetchedPage> {
    return Promise.resolve({ text: this.text, method: 'http' });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const config = { defaultWebhookUrl: undefined, webhookSecret: 's', webhookMaxAttempts: 6 };
const job = (payload: Record<string, unknown>, attempts = 1, maxAttempts = 5): Job => ({ id: 1, type: 't', payload, idempotencyKey: 'k', attempts, maxAttempts });

describeDb('monitoring pipeline (real Postgres, fake fetcher, mock LLM)', () => {
  const { db } = useTestDb();
  const deps = (fetcher: PageFetcher, llm: LlmProvider = new MockProvider()): HandlerDeps => ({ db: db(), config, fetcher, llm, log: logger });
  const count = async (sql: string) => Number((await db().query<{ n: string }>(sql)).rows[0]!.n);

  it('stores a baseline, ignores unchanged content, and records one change when content changes', async () => {
    const monitorId = await seedMonitor(db());
    const fetcher = new FakeFetcher('Gaming Console\n$499\nIn stock');
    const d = deps(fetcher);

    await checkMonitor(d, job({ monitorId }));
    expect(await count('SELECT count(*) AS n FROM snapshots')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM changes')).toBe(0);

    await checkMonitor(d, job({ monitorId })); // same content, e.g. a retried job
    expect(await count('SELECT count(*) AS n FROM snapshots')).toBe(1);

    fetcher.text = 'Gaming Console\n$549\nIn stock';
    await checkMonitor(d, job({ monitorId }));
    await checkMonitor(d, job({ monitorId })); // retry of the same job after the change was stored
    expect(await count('SELECT count(*) AS n FROM snapshots')).toBe(2);
    expect(await count('SELECT count(*) AS n FROM changes')).toBe(1);
    expect(await count("SELECT count(*) AS n FROM jobs WHERE type = 'classify_change'")).toBe(1);
  });

  it('filters timestamp-only changes before the LLM and never queues a classify job', async () => {
    const monitorId = await seedMonitor(db());
    const fetcher = new FakeFetcher('Status\nLast updated: 2026-03-03 14:05:11\nAll good');
    const llm = new MockProvider();
    const d = deps(fetcher, llm);
    await checkMonitor(d, job({ monitorId }));
    fetcher.text = 'Status\nLast updated: 2026-03-03 14:09:45\nAll good';
    await checkMonitor(d, job({ monitorId }));

    const change = (await db().query('SELECT status, category, meaningful FROM changes')).rows[0];
    expect(change).toEqual({ status: 'filtered_noise', category: 'noise', meaningful: false });
    expect(await count('SELECT count(*) AS n FROM jobs')).toBe(0);
    expect(llm.calls).toBe(0);
  });

  it('classifies a pending change, logs the LLM call and queues exactly one webhook job', async () => {
    const monitorId = await seedMonitor(db());
    const fetcher = new FakeFetcher('Gaming Console\n$499');
    const llm = new MockProvider();
    const d = deps(fetcher, llm);
    await checkMonitor(d, job({ monitorId }));
    fetcher.text = 'Gaming Console\n$699';
    await checkMonitor(d, job({ monitorId }));

    const changeId = (await db().query<{ id: string }>('SELECT id FROM changes')).rows[0]!.id;
    await classifyChange(d, job({ changeId }));
    await classifyChange(d, job({ changeId })); // duplicate delivery of the same job

    const change = (await db().query('SELECT status, meaningful, category, severity FROM changes')).rows[0];
    expect(change).toEqual({ status: 'classified', meaningful: true, category: 'price', severity: 'high' });
    expect(llm.calls).toBe(1); // second run saw it was already classified
    expect(await count("SELECT count(*) AS n FROM jobs WHERE type = 'deliver_webhook'")).toBe(1);
    const call = (await db().query('SELECT provider, model, outcome, latency_ms, input_tokens FROM llm_calls')).rows;
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ provider: 'mock', outcome: 'ok' });
    expect(call[0].input_tokens).toBeGreaterThan(0);
  });

  it('does not queue a webhook when the LLM says the change is not meaningful', async () => {
    const monitorId = await seedMonitor(db());
    const fetcher = new FakeFetcher('Welcome to our store!');
    const d = deps(fetcher);
    await checkMonitor(d, job({ monitorId }));
    fetcher.text = 'Welcome to our store';
    await checkMonitor(d, job({ monitorId }));
    const changeId = (await db().query<{ id: string }>('SELECT id FROM changes')).rows[0]!.id;
    await classifyChange(d, job({ changeId }));
    expect(await count("SELECT count(*) AS n FROM jobs WHERE type = 'deliver_webhook'")).toBe(0);
    expect((await db().query('SELECT category FROM changes')).rows[0].category).toBe('noise');
  });

  async function pendingChange(llm: LlmProvider) {
    const monitorId = await seedMonitor(db());
    const fetcher = new FakeFetcher('Item\n$10');
    const d = deps(fetcher, llm);
    await checkMonitor(d, job({ monitorId }));
    fetcher.text = 'Item\n$20';
    await checkMonitor(d, job({ monitorId }));
    return { d, changeId: (await db().query<{ id: string }>('SELECT id FROM changes')).rows[0]!.id };
  }

  it('turns an LLM 429 into a retry that honours Retry-After, and logs the failed call', async () => {
    const { d, changeId } = await pendingChange(new MockProvider(() => new LlmError('rate_limit', 'slow down', 45_000)));
    const worker = new Worker({ db: db(), handlers: createHandlers(d), log: logger, backoff: { baseMs: 0, capMs: 0 } });
    await db().query("DELETE FROM jobs WHERE type = 'check_monitor'");
    await worker.runOnce();

    const queued = (await db().query("SELECT status, run_at, attempts FROM jobs WHERE type = 'classify_change'")).rows[0];
    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBe(1);
    expect(queued.run_at.getTime() - Date.now()).toBeGreaterThan(40_000);
    expect((await db().query('SELECT status FROM changes WHERE id = $1', [changeId])).rows[0].status).toBe('pending');
    expect((await db().query('SELECT outcome FROM llm_calls')).rows).toEqual([{ outcome: 'rate_limit' }]);
  });

  it('dead-letters a refusal at once and marks the change failed', async () => {
    const { d, changeId } = await pendingChange(new MockProvider(() => new LlmError('refusal', 'no')));
    const worker = new Worker({ db: db(), handlers: createHandlers(d), log: logger, backoff: { baseMs: 0, capMs: 0 } });
    await worker.runOnce();
    expect((await db().query("SELECT status FROM jobs WHERE type = 'classify_change'")).rows[0].status).toBe('dead');
    expect((await db().query('SELECT status, error FROM changes WHERE id = $1', [changeId])).rows[0]).toEqual({ status: 'failed', error: 'no' });
  });

  it('marks the change failed when malformed output exhausts all attempts', async () => {
    const { d, changeId } = await pendingChange(new MockProvider(() => new LlmError('malformed', 'bad json')));
    await expect(classifyChange(d, job({ changeId }, 5, 5))).rejects.toMatchObject({ kind: 'malformed' });
    expect((await db().query('SELECT status FROM changes WHERE id = $1', [changeId])).rows[0].status).toBe('failed');
  });

  it('records a fetch error on the monitor and rethrows so the job retries', async () => {
    const monitorId = await seedMonitor(db());
    const broken: PageFetcher = { fetch: () => Promise.reject(new Error('connect ECONNREFUSED')), close: () => Promise.resolve() };
    await expect(checkMonitor(deps(broken), job({ monitorId }))).rejects.toThrow('ECONNREFUSED');
    expect((await db().query('SELECT last_error FROM monitors')).rows[0].last_error).toContain('ECONNREFUSED');
  });

  describe('scheduler', () => {
    it('enqueues one check per due monitor, once per slot', async () => {
      await seedMonitor(db());
      await seedMonitor(db());
      expect(await scheduleDueChecks(db())).toBe(2);
      expect(await scheduleDueChecks(db())).toBe(0); // next_check_at moved into the future
      expect(await count("SELECT count(*) AS n FROM jobs WHERE type = 'check_monitor'")).toBe(2);
      const claimed = await claimJob(db(), 'w', 1000);
      expect(claimed?.type).toBe('check_monitor');
    });
  });
});

describeDb('REST API (real Postgres)', () => {
  const { db } = useTestDb();
  const app = (d: Db) => buildServer({ db: d, config: { allowPrivateHosts: false } });

  it('creates, lists and deletes monitors', async () => {
    const server = app(db());
    const created = await server.inject({ method: 'POST', url: '/monitors', payload: { url: 'https://example.com/pricing', intervalSeconds: 60 } });
    expect(created.statusCode).toBe(201);
    const monitor = created.json<{ id: string; name: string; intervalSeconds: number }>();
    expect(monitor).toMatchObject({ name: 'example.com', intervalSeconds: 60 });

    expect((await server.inject({ method: 'GET', url: '/monitors' })).json<unknown[]>()).toHaveLength(1);
    expect((await server.inject({ method: 'DELETE', url: `/monitors/${monitor.id}` })).statusCode).toBe(204);
    expect((await server.inject({ method: 'DELETE', url: `/monitors/${monitor.id}` })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/monitors' })).json<unknown[]>()).toHaveLength(0);
  });

  it('rejects bad input and private URLs with 400', async () => {
    const server = app(db());
    expect((await server.inject({ method: 'POST', url: '/monitors', payload: {} })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/monitors', payload: { url: 'http://169.254.169.254/' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/monitors', payload: { url: 'https://example.com', intervalSeconds: 1 } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'DELETE', url: '/monitors/not-a-uuid' })).statusCode).toBe(400);
  });

  it('queues a manual check, lists changes and serves health and the dashboard', async () => {
    const server = app(db());
    const id = await seedMonitor(db());
    const check = await server.inject({ method: 'POST', url: `/monitors/${id}/check` });
    expect(check.statusCode).toBe(202);

    const health = (await server.inject({ method: 'GET', url: '/health' })).json<{ status: string; jobs: Record<string, number> }>();
    expect(health.status).toBe('ok');
    expect(health.jobs.queued).toBe(1);

    expect((await server.inject({ method: 'GET', url: '/changes' })).json<unknown[]>()).toEqual([]);
    const page = await server.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Website Watchdog');
  });
});
