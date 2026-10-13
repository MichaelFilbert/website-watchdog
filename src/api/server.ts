import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { pino } from 'pino';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { validateMonitorUrl } from '../fetch/url-guard.js';
import { enqueue, jobStats } from '../queue/queue.js';

const DASHBOARD_URL = new URL('../../public/dashboard.html', import.meta.url);

const CreateMonitorSchema = z.object({
  url: z.string().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  webhookUrl: z.string().url().optional(),
  intervalSeconds: z.number().int().min(10).max(86_400).default(300),
});
const IdParams = z.object({ id: z.string().uuid() });
const ChangesQuery = z.object({
  monitorId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface MonitorRow {
  id: string;
  url: string;
  name: string;
  webhook_url: string | null;
  interval_seconds: number;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

const presentMonitor = (m: MonitorRow) => ({
  id: m.id,
  url: m.url,
  name: m.name,
  webhookUrl: m.webhook_url,
  intervalSeconds: m.interval_seconds,
  lastCheckedAt: m.last_checked_at,
  lastError: m.last_error,
  createdAt: m.created_at,
});

export function buildServer(deps: { db: Db; config: Pick<Config, 'allowPrivateHosts'>; logger?: Logger }) {
  const { db, config } = deps;
  const app = Fastify({ loggerInstance: deps.logger ?? pino({ level: 'silent' }) });

  app.get('/', async (_req, reply) => reply.type('text/html').send(await readFile(DASHBOARD_URL, 'utf8')));

  app.get('/health', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok', db: 'ok', jobs: await jobStats(db) };
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });

  app.post('/monitors', async (req, reply) => {
    const body = CreateMonitorSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
    const checked = validateMonitorUrl(body.data.url, config.allowPrivateHosts);
    if (!checked.ok) return reply.code(400).send({ error: 'invalid_url', message: checked.reason });
    const name = body.data.name ?? new URL(checked.url).hostname;
    const { rows } = await db.query<MonitorRow>(
      `INSERT INTO monitors (url, name, webhook_url, interval_seconds) VALUES ($1, $2, $3, $4) RETURNING *`,
      [checked.url, name, body.data.webhookUrl ?? null, body.data.intervalSeconds],
    );
    return reply.code(201).send(presentMonitor(rows[0]!));
  });

  app.get('/monitors', async () => {
    const { rows } = await db.query<MonitorRow>('SELECT * FROM monitors ORDER BY created_at DESC');
    return rows.map(presentMonitor);
  });

  app.delete('/monitors/:id', async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_id' });
    const res = await db.query('DELETE FROM monitors WHERE id = $1', [params.data.id]);
    return res.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  // Queue a check right now instead of waiting for the schedule.
  app.post('/monitors/:id/check', async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_id' });
    const exists = await db.query('SELECT 1 FROM monitors WHERE id = $1', [params.data.id]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'not_found' });
    const jobId = await enqueue(db, {
      type: 'check_monitor',
      payload: { monitorId: params.data.id },
      idempotencyKey: `check:${params.data.id}:manual:${Date.now()}`,
    });
    return reply.code(202).send({ jobId });
  });

  app.get('/changes', async (req, reply) => {
    const query = ChangesQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request', details: query.error.issues });
    const { rows } = await db.query(
      `SELECT c.id, c.monitor_id AS "monitorId", m.name AS "monitorName", m.url, c.status, c.meaningful,
              c.category, c.severity, c.summary, c.error, c.created_at AS "createdAt",
              EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.change_id = c.id AND d.outcome = 'success') AS "webhookDelivered"
       FROM changes c JOIN monitors m ON m.id = c.monitor_id
       WHERE ($1::uuid IS NULL OR c.monitor_id = $1)
       ORDER BY c.created_at DESC LIMIT $2`,
      [query.data.monitorId ?? null, query.data.limit],
    );
    return rows;
  });

  return app;
}
