import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, inject } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import type { Db } from '../../src/db/pool.js';

export const dbAvailable = inject('dbAvailable');

/** `describe` that is skipped (with the reason visible in the output) when Postgres is not reachable. */
export const describeDb = dbAvailable ? describe : describe.skip;

export function useTestDb(): { db: () => Db } {
  let pool: Db;
  beforeAll(() => {
    pool = createPool(inject('testDatabaseUrl'));
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE monitors, jobs, llm_calls, webhook_deliveries RESTART IDENTITY CASCADE');
  });
  return { db: () => pool };
}

export interface ReceivedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local HTTP server standing in for a customer's webhook endpoint. */
export async function startReceiver(respond: (n: number) => { status: number; headers?: Record<string, string> } = () => ({ status: 200 })) {
  const received: ReceivedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const { status, headers } = respond(received.length);
      res.writeHead(status, headers);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { url, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export async function seedMonitor(db: Db, over: { url?: string; webhookUrl?: string | null; name?: string } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO monitors (url, name, webhook_url) VALUES ($1, $2, $3) RETURNING id',
    [over.url ?? 'https://shop.example/product', over.name ?? 'Shop', over.webhookUrl ?? null],
  );
  return rows[0]!.id;
}
