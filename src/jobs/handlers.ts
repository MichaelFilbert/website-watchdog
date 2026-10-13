import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { PageFetcher } from '../fetch/types.js';
import { classifyAndLog } from '../llm/classify.js';
import type { LlmProvider } from '../llm/types.js';
import { LlmError } from '../llm/types.js';
import type { Logger } from '../logger.js';
import { PermanentError, RetryLaterError } from '../queue/errors.js';
import { enqueue } from '../queue/queue.js';
import type { Job } from '../queue/queue.js';
import type { JobHandler } from '../queue/worker.js';
import { diffLines, leadingContext } from '../text/diff.js';
import { filterNoise } from '../text/noise.js';
import { hashText, normalizeText } from '../text/normalize.js';
import { deliverWebhook } from '../webhooks/deliver.js';

export interface HandlerDeps {
  db: Db;
  config: Pick<Config, 'defaultWebhookUrl' | 'webhookSecret' | 'webhookMaxAttempts'>;
  fetcher: PageFetcher;
  llm: LlmProvider;
  log: Logger;
  /** Overridable so tests can use a local receiver / stub. */
  webhookFetch?: typeof fetch;
}

export const classifyKey = (monitorId: string, contentHash: string) => `classify:${monitorId}:${contentHash}`;
export const webhookKey = (changeId: string) => `webhook:${changeId}`;

export function createHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  return {
    check_monitor: (job) => checkMonitor(deps, job),
    classify_change: (job) => classifyChange(deps, job),
    deliver_webhook: (job) => sendWebhook(deps, job),
  };
}

/**
 * Fetch -> normalise -> compare with the latest snapshot. Everything that follows a
 * detected change (snapshot row, change row, next job) is written in ONE transaction,
 * so a crash can never leave a snapshot without its classify job, and a re-run of the
 * same job finds the snapshot already stored and does nothing.
 */
export async function checkMonitor({ db, fetcher, log }: HandlerDeps, job: Job): Promise<void> {
  const monitorId = String(job.payload.monitorId);
  const monitor = (await db.query<{ url: string }>('SELECT url FROM monitors WHERE id = $1 AND active', [monitorId])).rows[0];
  if (!monitor) return; // deleted or paused since it was scheduled

  let page;
  try {
    page = await fetcher.fetch(monitor.url);
  } catch (err) {
    await db.query('UPDATE monitors SET last_error = $2, last_checked_at = now() WHERE id = $1', [monitorId, (err as Error).message]);
    throw err;
  }

  const text = normalizeText(page.text);
  const hash = hashText(text);

  await withTransaction(db, async (tx) => {
    await tx.query('UPDATE monitors SET last_checked_at = now(), last_error = NULL WHERE id = $1', [monitorId]);
    const previous = (
      await tx.query<{ id: string; content_hash: string; text: string }>(
        'SELECT id, content_hash, text FROM snapshots WHERE monitor_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [monitorId],
      )
    ).rows[0];
    if (previous?.content_hash === hash) return; // unchanged

    const snapshot = (
      await tx.query<{ id: string }>(
        'INSERT INTO snapshots (monitor_id, content_hash, text, fetch_method) VALUES ($1, $2, $3, $4) RETURNING id',
        [monitorId, hash, text, page.method],
      )
    ).rows[0]!;
    if (!previous) {
      log.info({ monitorId }, 'baseline snapshot stored');
      return;
    }

    const diff = diffLines(previous.text, text);
    const verdict = filterNoise(diff);
    const context = leadingContext(text, diff);
    const change = (
      await tx.query<{ id: string }>(
        `INSERT INTO changes (monitor_id, previous_snapshot_id, snapshot_id, added, removed, context, status, meaningful, category, severity, summary, classified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          monitorId,
          previous.id,
          snapshot.id,
          JSON.stringify(verdict.added),
          JSON.stringify(verdict.removed),
          JSON.stringify(context),
          verdict.isNoise ? 'filtered_noise' : 'pending',
          verdict.isNoise ? false : null,
          verdict.isNoise ? 'noise' : null,
          verdict.isNoise ? 'low' : null,
          verdict.isNoise ? `Filtered before LLM: ${verdict.reason}` : null,
          verdict.isNoise ? new Date() : null,
        ],
      )
    ).rows[0]!;
    log.info({ monitorId, changeId: change.id, noise: verdict.isNoise, reason: verdict.reason }, 'change detected');
    if (!verdict.isNoise) {
      await enqueue(tx, {
        type: 'classify_change',
        payload: { changeId: change.id },
        idempotencyKey: classifyKey(monitorId, hash),
      });
    }
  });
}

/** Ask the LLM to confirm a change that survived the pre-filter, store the verdict, and queue a webhook if it matters. */
export async function classifyChange({ db, llm, log, config }: HandlerDeps, job: Job): Promise<void> {
  const changeId = String(job.payload.changeId);
  const change = (
    await db.query<{ status: string; added: string[]; removed: string[]; context: string[]; url: string }>(
      `SELECT c.status, c.added, c.removed, c.context, m.url FROM changes c JOIN monitors m ON m.id = c.monitor_id WHERE c.id = $1`,
      [changeId],
    )
  ).rows[0];
  if (!change) throw new PermanentError(`Change ${changeId} not found`);
  if (change.status !== 'pending') return; // already handled by an earlier attempt

  try {
    const { classification } = await classifyAndLog(
      llm,
      { url: change.url, added: change.added, removed: change.removed, context: change.context },
      async (r) => {
        await db.query(
          `INSERT INTO llm_calls (change_id, provider, model, latency_ms, input_tokens, output_tokens, cost_usd, outcome, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [changeId, r.provider, r.model, r.latencyMs, r.inputTokens, r.outputTokens, r.costUsd, r.outcome, r.error ?? null],
        );
      },
    );

    await withTransaction(db, async (tx) => {
      const updated = await tx.query(
        `UPDATE changes SET status = 'classified', meaningful = $2, category = $3, severity = $4, summary = $5, classified_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [changeId, classification.meaningful, classification.category, classification.severity, classification.summary],
      );
      if (updated.rowCount && classification.meaningful) {
        await enqueue(tx, {
          type: 'deliver_webhook',
          payload: { changeId },
          idempotencyKey: webhookKey(changeId),
          maxAttempts: config.webhookMaxAttempts,
        });
      }
    });
    log.info({ changeId, ...classification }, 'change classified');
  } catch (err) {
    const permanent = err instanceof LlmError && !err.retryable;
    if (permanent || job.attempts >= job.maxAttempts) {
      await db.query(`UPDATE changes SET status = 'failed', error = $2 WHERE id = $1 AND status = 'pending'`, [changeId, (err as Error).message]);
    }
    if (permanent) throw new PermanentError((err as Error).message);
    if (err instanceof LlmError && err.retryAfterMs !== undefined) throw new RetryLaterError(err.message, err.retryAfterMs);
    throw err;
  }
}

async function sendWebhook(deps: HandlerDeps, job: Job): Promise<void> {
  const result = await deliverWebhook(
    {
      db: deps.db,
      secret: deps.config.webhookSecret,
      defaultWebhookUrl: deps.config.defaultWebhookUrl,
      fetchImpl: deps.webhookFetch,
    },
    String(job.payload.changeId),
    job.attempts,
  );
  deps.log.info({ changeId: job.payload.changeId, result }, 'webhook job finished');
}
