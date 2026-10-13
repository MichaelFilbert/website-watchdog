import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { enqueue } from '../queue/queue.js';

export const checkKey = (monitorId: string, slot: number) => `check:${monitorId}:${slot}`;

/**
 * Enqueues a check for every monitor that is due and pushes its next_check_at forward.
 * Runs in one transaction with SKIP LOCKED, so several scheduler processes can run at once
 * without double-scheduling, and the idempotency key covers any remaining overlap.
 */
export async function scheduleDueChecks(db: Db): Promise<number> {
  return withTransaction(db, async (tx) => {
    const due = await tx.query<{ id: string; slot: string; interval_seconds: number }>(
      `SELECT id, (extract(epoch FROM next_check_at) * 1000)::bigint AS slot, interval_seconds
       FROM monitors WHERE active AND next_check_at <= now()
       ORDER BY next_check_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    for (const m of due.rows) {
      await enqueue(tx, { type: 'check_monitor', payload: { monitorId: m.id }, idempotencyKey: checkKey(m.id, Number(m.slot)) });
      await tx.query(`UPDATE monitors SET next_check_at = now() + make_interval(secs => $2) WHERE id = $1`, [m.id, m.interval_seconds]);
    }
    return due.rows.length;
  });
}

export function startScheduler(db: Db, log: Logger, pollMs: number): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> = Promise.resolve();

  const tick = () => {
    inflight = scheduleDueChecks(db)
      .then((n) => {
        if (n > 0) log.info({ scheduled: n }, 'scheduled monitor checks');
      })
      .catch((err: unknown) => log.error({ err: (err as Error).message }, 'scheduler tick failed'))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, pollMs);
      });
  };
  tick();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inflight;
  };
}
