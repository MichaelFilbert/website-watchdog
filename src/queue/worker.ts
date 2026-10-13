import type { Db } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { PermanentError, RetryLaterError } from './errors.js';
import { claimJob, completeJob, failJob, reapExpiredLeases } from './queue.js';
import type { Job } from './queue.js';
import type { BackoffOptions } from './backoff.js';

export type JobHandler = (job: Job) => Promise<void>;

export interface WorkerOptions {
  db: Db;
  handlers: Record<string, JobHandler>;
  log: Logger;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  backoff: BackoffOptions;
}

export class Worker {
  private running = false;
  private loop?: Promise<void>;
  private readonly workerId: string;
  private readonly leaseMs: number;

  constructor(private readonly opts: WorkerOptions) {
    this.workerId = opts.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.leaseMs = opts.leaseMs ?? 60_000;
  }

  /** Claims and runs at most one job. Returns false when the queue had nothing due. */
  async runOnce(): Promise<boolean> {
    const { db, handlers, log, backoff } = this.opts;
    const job = await claimJob(db, this.workerId, this.leaseMs);
    if (!job) return false;

    const jobLog = log.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    const handler = handlers[job.type];
    try {
      if (!handler) throw new PermanentError(`No handler registered for job type "${job.type}"`);
      await handler(job);
      if (await completeJob(db, job)) jobLog.info('job succeeded');
      else jobLog.warn('job finished after its lease expired and was taken over; result not recorded');
    } catch (err) {
      const outcome = await failJob(db, job, err, {
        backoff,
        permanent: err instanceof PermanentError,
        retryAfterMs: err instanceof RetryLaterError ? err.retryAfterMs : undefined,
      });
      jobLog[outcome === 'dead' ? 'error' : 'warn']({ err: (err as Error).message, outcome }, 'job failed');
    }
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    const { db, log, pollMs = 1000 } = this.opts;
    let lastReap = 0;
    while (this.running) {
      try {
        if (Date.now() - lastReap > 15_000) {
          lastReap = Date.now();
          const reaped = await reapExpiredLeases(db);
          if (reaped > 0) log.warn({ reaped }, 'recovered jobs from crashed workers');
        }
        const didWork = await this.runOnce();
        if (!didWork) await sleep(pollMs);
      } catch (err) {
        log.error({ err: (err as Error).message }, 'worker loop error (database unreachable?)');
        await sleep(pollMs * 2);
      }
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
