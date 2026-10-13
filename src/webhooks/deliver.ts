import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { PermanentError, RetryLaterError } from '../queue/errors.js';
import { parseRetryAfterMs } from '../llm/anthropic.js';
import { buildWebhookBody } from './payload.js';
import { DELIVERY_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signPayload } from './sign.js';

export interface DeliverDeps {
  db: Db;
  secret: string;
  defaultWebhookUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ChangeRow {
  id: string;
  category: string;
  severity: string;
  summary: string;
  created_at: Date;
  monitor_name: string;
  monitor_url: string;
  webhook_url: string | null;
}

/**
 * Delivers the notification for one change. Safe to call repeatedly:
 *  - if a successful delivery is already logged, it does nothing (dedupe);
 *  - the partial unique index on webhook_deliveries makes a double success impossible
 *    even if two workers race.
 * Failures throw so the job queue retries with backoff and eventually dead-letters.
 * Delivery is at-least-once (a crash between the HTTP 2xx and the log insert could
 * resend), so every request carries a stable X-Watchdog-Delivery id for receivers to dedupe on.
 */
export async function deliverWebhook(deps: DeliverDeps, changeId: string, attempt: number): Promise<'sent' | 'already_sent' | 'no_destination'> {
  const { db, secret, fetchImpl = fetch, timeoutMs = 5000 } = deps;

  const found = await db.query<ChangeRow>(
    `SELECT c.id, c.category, c.severity, c.summary, c.created_at,
            m.name AS monitor_name, m.url AS monitor_url, m.webhook_url
     FROM changes c JOIN monitors m ON m.id = c.monitor_id
     WHERE c.id = $1`,
    [changeId],
  );
  const change = found.rows[0];
  if (!change) throw new PermanentError(`Change ${changeId} no longer exists`);

  const url = change.webhook_url ?? deps.defaultWebhookUrl;
  if (!url) return 'no_destination';

  const already = await db.query('SELECT 1 FROM webhook_deliveries WHERE change_id = $1 AND outcome = $2', [changeId, 'success']);
  if (already.rowCount) return 'already_sent';

  const body = buildWebhookBody({
    changeId,
    monitorName: change.monitor_name,
    url: change.monitor_url,
    category: change.category,
    severity: change.severity,
    summary: change.summary,
    detectedAt: change.created_at.toISOString(),
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const started = performance.now();

  const record = (outcome: 'success' | 'failure', statusCode: number | null, error: string | null) =>
    db.query(
      `INSERT INTO webhook_deliveries (change_id, url, attempt, outcome, status_code, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [changeId, url, attempt, outcome, statusCode, error, Math.round(performance.now() - started)],
    );

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'website-watchdog/0.1',
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
        [DELIVERY_HEADER]: changeId,
        'idempotency-key': changeId,
        'x-request-id': randomUUID(),
      },
      body,
    });
  } catch (err) {
    const message = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
    await record('failure', null, message);
    throw new Error(`Webhook request failed: ${message}`, { cause: err });
  }

  if (res.status >= 200 && res.status < 300) {
    await record('success', res.status, null);
    return 'sent';
  }

  await record('failure', res.status, `HTTP ${res.status}`);
  if (res.status === 429) {
    throw new RetryLaterError('Webhook receiver rate limited us (429)', parseRetryAfterMs(res.headers.get('retry-after')) ?? 30_000);
  }
  // Other 4xx (except 408 timeout) mean the request itself is wrong: retrying will not help.
  if (res.status >= 400 && res.status < 500 && res.status !== 408) {
    throw new PermanentError(`Webhook receiver rejected the request (HTTP ${res.status})`);
  }
  throw new Error(`Webhook receiver returned HTTP ${res.status}`);
}
