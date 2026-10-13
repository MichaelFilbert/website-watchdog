import type { Db, Queryable } from '../db/pool.js';
import { backoffDelayMs } from './backoff.js';
import type { BackoffOptions } from './backoff.js';

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  type: string;
  payload: Record<string, unknown>;
  /** Same key = same job. A second enqueue with the same key is ignored. */
  idempotencyKey: string;
  runAt?: Date;
  maxAttempts?: number;
}

interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
}

const toJob = (r: JobRow): Job => ({
  id: Number(r.id),
  type: r.type,
  payload: r.payload,
  idempotencyKey: r.idempotency_key,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
});

/** Returns the job id, or null if a job with this idempotency key already exists. */
export async function enqueue(db: Queryable, opts: EnqueueOptions): Promise<number | null> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, idempotency_key, run_at, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [opts.type, JSON.stringify(opts.payload), opts.idempotencyKey, opts.runAt ?? null, opts.maxAttempts ?? 5],
  );
  return res.rows[0] ? Number(res.rows[0].id) : null;
}

/**
 * Claims one due job. FOR UPDATE SKIP LOCKED makes concurrent workers skip rows
 * another worker is already claiming instead of waiting on them, so N workers
 * each get a different job and none blocks. The claim also takes a lease
 * (locked_until): if the worker dies, `reapExpiredLeases` hands the job back.
 */
export async function claimJob(db: Queryable, workerId: string, leaseMs: number): Promise<Job | null> {
  const res = await db.query<JobRow>(
    `WITH next AS (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE jobs j
     SET status = 'running',
         attempts = j.attempts + 1,
         locked_by = $1,
         locked_until = now() + make_interval(secs => $2::double precision / 1000),
         updated_at = now()
     FROM next
     WHERE j.id = next.id
     RETURNING j.id, j.type, j.payload, j.idempotency_key, j.attempts, j.max_attempts`,
    [workerId, leaseMs],
  );
  return res.rows[0] ? toJob(res.rows[0]) : null;
}

export async function completeJob(db: Queryable, jobId: number): Promise<void> {
  await db.query(
    `UPDATE jobs SET status = 'succeeded', locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

export type FailOutcome = 'retry' | 'dead';

export interface FailOptions {
  backoff: BackoffOptions;
  /** Skip remaining attempts (e.g. PermanentError). */
  permanent?: boolean;
  /** A server-provided delay (Retry-After) overrides computed backoff. */
  retryAfterMs?: number;
  random?: () => number;
}

/** Schedules a retry with backoff, or moves the job to the dead-letter state ('dead') when attempts are used up. */
export async function failJob(db: Queryable, job: Job, error: unknown, opts: FailOptions): Promise<FailOutcome> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  if (opts.permanent || job.attempts >= job.maxAttempts) {
    await db.query(
      `UPDATE jobs SET status = 'dead', locked_by = NULL, locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
      [job.id, message],
    );
    return 'dead';
  }
  const delayMs = opts.retryAfterMs ?? backoffDelayMs(job.attempts, opts.backoff, opts.random);
  await db.query(
    `UPDATE jobs
     SET status = 'queued', locked_by = NULL, locked_until = NULL, last_error = $2,
         run_at = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
     WHERE id = $1`,
    [job.id, message, delayMs],
  );
  return 'retry';
}

/**
 * Crash recovery: a 'running' job whose lease expired belongs to a worker that died.
 * Put it back in the queue (or dead-letter it if it already used all its attempts,
 * which protects against a job that crashes the worker every time).
 */
export async function reapExpiredLeases(db: Queryable): Promise<number> {
  const res = await db.query(
    `UPDATE jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
         last_error = 'worker lease expired (worker presumed crashed)',
         locked_by = NULL, locked_until = NULL, run_at = now(), updated_at = now()
     WHERE status = 'running' AND locked_until < now()`,
  );
  return res.rowCount ?? 0;
}

export async function jobStats(db: Db): Promise<Record<string, number>> {
  const res = await db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM jobs GROUP BY status');
  const stats: Record<string, number> = { queued: 0, running: 0, succeeded: 0, dead: 0 };
  for (const row of res.rows) stats[row.status] = Number(row.n);
  return stats;
}
