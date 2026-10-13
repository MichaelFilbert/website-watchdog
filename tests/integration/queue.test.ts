import { describe, expect, it } from 'vitest';
import { PermanentError, RetryLaterError } from '../../src/queue/errors.js';
import { claimJob, completeJob, enqueue, failJob, reapExpiredLeases } from '../../src/queue/queue.js';
import { Worker } from '../../src/queue/worker.js';
import { logger } from '../../src/logger.js';
import { describeDb, useTestDb } from './helpers.js';

const backoff = { baseMs: 1000, capMs: 60_000 };

describeDb('job queue (real Postgres)', () => {
  const { db } = useTestDb();
  const job = (key: string, extra: Partial<Parameters<typeof enqueue>[1]> = {}) => enqueue(db(), { type: 't', payload: { key }, idempotencyKey: key, ...extra });
  const row = async (id: number) => (await db().query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0] as Record<string, unknown>;

  it('ignores a second enqueue with the same idempotency key', async () => {
    const first = await job('k1');
    const second = await job('k1');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect((await db().query('SELECT count(*) FROM jobs')).rows[0].count).toBe('1');
  });

  it('lets concurrent workers claim every job exactly once (SKIP LOCKED)', async () => {
    const total = 60;
    for (let i = 0; i < total; i++) await job(`job-${i}`);

    const claimedBy = async (workerId: string) => {
      const ids: number[] = [];
      for (;;) {
        const claimed = await claimJob(db(), workerId, 30_000);
        if (!claimed) return ids;
        ids.push(claimed.id);
      }
    };
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claimedBy(`w${i}`)));
    const all = results.flat();

    expect(all).toHaveLength(total);
    expect(new Set(all).size).toBe(total); // no job handed to two workers
    expect(results.filter((ids) => ids.length > 0).length).toBeGreaterThan(1); // work was actually shared
  });

  it('does not claim jobs scheduled for the future', async () => {
    await job('later', { runAt: new Date(Date.now() + 60_000) });
    expect(await claimJob(db(), 'w', 30_000)).toBeNull();
  });

  it('claims in run_at order and counts the attempt', async () => {
    await job('b', { runAt: new Date(Date.now() - 1000) });
    await job('a', { runAt: new Date(Date.now() - 5000) });
    const first = await claimJob(db(), 'w', 30_000);
    expect(first?.idempotencyKey).toBe('a');
    expect(first?.attempts).toBe(1);
  });

  it('schedules a retry with backoff after a failure', async () => {
    await job('flaky', { maxAttempts: 3 });
    const claimed = (await claimJob(db(), 'w', 30_000))!;
    const outcome = await failJob(db(), claimed, new Error('boom'), { backoff, random: () => 0.5 });
    const after = await row(claimed.id);
    expect(outcome).toBe('retry');
    expect(after.status).toBe('queued');
    expect(after.last_error).toBe('boom');
    // attempt 1, base 1000ms, jitter 0.5 -> 500ms in the future
    const delay = (after.run_at as Date).getTime() - Date.now();
    expect(delay).toBeGreaterThan(200);
    expect(delay).toBeLessThan(900);
    expect(await claimJob(db(), 'w', 30_000)).toBeNull(); // not due yet
  });

  it('moves a job to dead-letter after max attempts', async () => {
    await job('doomed', { maxAttempts: 2 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const claimed = (await claimJob(db(), 'w', 30_000))!;
      expect(claimed.attempts).toBe(attempt);
      const outcome = await failJob(db(), claimed, new Error(`fail ${attempt}`), { backoff: { baseMs: 0, capMs: 0 } });
      expect(outcome).toBe(attempt === 2 ? 'dead' : 'retry');
    }
    const dead = (await db().query("SELECT * FROM jobs WHERE status = 'dead'")).rows[0];
    expect(dead.last_error).toBe('fail 2');
    expect(await claimJob(db(), 'w', 30_000)).toBeNull();
  });

  it('dead-letters immediately for permanent errors and honours Retry-After for others', async () => {
    await job('perm', { maxAttempts: 5 });
    const a = (await claimJob(db(), 'w', 30_000))!;
    expect(await failJob(db(), a, new PermanentError('bad input'), { backoff, permanent: true })).toBe('dead');

    await job('rate', { maxAttempts: 5 });
    const b = (await claimJob(db(), 'w', 30_000))!;
    await failJob(db(), b, new RetryLaterError('429', 90_000), { backoff, retryAfterMs: 90_000 });
    const delay = ((await row(b.id)).run_at as Date).getTime() - Date.now();
    expect(delay).toBeGreaterThan(85_000);
  });

  it('recovers a job whose worker crashed (expired lease) and keeps its attempt count', async () => {
    await job('crashy', { maxAttempts: 3 });
    const claimed = (await claimJob(db(), 'dead-worker', 30_000))!;
    expect(await reapExpiredLeases(db())).toBe(0); // lease still valid

    await db().query("UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [claimed.id]);
    expect(await reapExpiredLeases(db())).toBe(1);

    const again = (await claimJob(db(), 'healthy-worker', 30_000))!;
    expect(again.id).toBe(claimed.id);
    expect(again.attempts).toBe(2);
  });

  it('dead-letters a crashed job that has no attempts left (poison job protection)', async () => {
    await job('poison', { maxAttempts: 1 });
    const claimed = (await claimJob(db(), 'w', 30_000))!;
    await db().query("UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [claimed.id]);
    await reapExpiredLeases(db());
    expect((await row(claimed.id)).status).toBe('dead');
  });

  it('ignores a late completion or failure from a worker whose lease was taken over', async () => {
    await job('slow');
    const slow = (await claimJob(db(), 'slow-worker', 30_000))!;
    await db().query("UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [slow.id]);
    await reapExpiredLeases(db());
    const takeover = (await claimJob(db(), 'healthy-worker', 30_000))!;
    expect(takeover.id).toBe(slow.id);

    expect(await completeJob(db(), slow)).toBe(false);
    expect(await failJob(db(), slow, new Error('late'), { backoff })).toBe('lost');
    expect(await row(slow.id)).toMatchObject({ status: 'running', locked_by: 'healthy-worker' });

    expect(await completeJob(db(), takeover)).toBe(true);
    expect((await row(slow.id)).status).toBe('succeeded');
  });

  it('completes a job and records success', async () => {
    await job('ok');
    const claimed = (await claimJob(db(), 'w', 30_000))!;
    await completeJob(db(), claimed);
    expect((await row(claimed.id)).status).toBe('succeeded');
  });

  describe('Worker', () => {
    const make = (handlers: Record<string, () => Promise<void>>) => new Worker({ db: db(), handlers, log: logger, backoff: { baseMs: 0, capMs: 0 } });

    it('runs the handler, retries failures and dead-letters unknown job types', async () => {
      let calls = 0;
      const worker = make({
        t: () => {
          calls++;
          return calls < 2 ? Promise.reject(new Error('first try fails')) : Promise.resolve();
        },
      });
      await job('w1');
      await enqueue(db(), { type: 'mystery', payload: {}, idempotencyKey: 'mystery' });

      while (await worker.runOnce()) {
        /* drain */
      }
      const statuses = Object.fromEntries((await db().query('SELECT idempotency_key, status, attempts FROM jobs')).rows.map((r) => [r.idempotency_key, `${r.status}/${r.attempts}`]));
      expect(statuses).toEqual({ w1: 'succeeded/2', mystery: 'dead/1' });
    });
  });
});
