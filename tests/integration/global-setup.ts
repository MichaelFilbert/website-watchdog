import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dbAvailable: boolean;
    testDatabaseUrl: string;
  }
}

/**
 * Uses a dedicated `watchdog_test` database on the same Postgres server as the dev DB
 * (docker compose locally, a service container in CI), so tests never touch dev data.
 * If no server is reachable, integration tests skip with a loud message instead of failing.
 */
export default async function setup(project: TestProject): Promise<void> {
  const baseUrl = process.env.DATABASE_URL ?? 'postgres://watchdog:watchdog@localhost:5432/watchdog';
  const testUrl = process.env.TEST_DATABASE_URL ?? withDatabase(baseUrl, 'watchdog_test');
  project.provide('testDatabaseUrl', testUrl);

  try {
    const admin = new pg.Client({ connectionString: withDatabase(baseUrl, 'postgres'), connectionTimeoutMillis: 3000 });
    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [new URL(testUrl).pathname.slice(1)]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE ${new URL(testUrl).pathname.slice(1)}`);
    await admin.end();

    const db = createPool(testUrl);
    await migrate(db);
    await db.end();
    project.provide('dbAvailable', true);
  } catch (err) {
    console.warn(
      `\n!!! SKIPPING INTEGRATION TESTS: cannot reach Postgres (${(err as Error).message}).\n!!! Start it with "docker compose up -d --wait" and re-run.\n`,
    );
    project.provide('dbAvailable', false);
  }
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
