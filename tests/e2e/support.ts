import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '../..');

export function e2eDatabaseUrl(): string {
  const u = new URL(process.env.DATABASE_URL ?? 'postgres://watchdog:watchdog@localhost:5432/watchdog');
  u.pathname = '/watchdog_e2e';
  return u.toString();
}

/** Creates the e2e database if needed and empties it, so every run starts clean. */
export async function resetE2eDatabase(): Promise<void> {
  const url = e2eDatabaseUrl();
  const admin = new pg.Client({ connectionString: url.replace('/watchdog_e2e', '/postgres') });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'watchdog_e2e'");
  if (!exists.rowCount) await admin.query('CREATE DATABASE watchdog_e2e');
  await admin.end();
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); // the app re-runs migrations on start
  await db.end();
}

export interface Listening {
  url: string;
  close(): Promise<void>;
}

async function listen(server: http.Server): Promise<Listening> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A tiny website whose content the test can change between checks. */
export async function startFixtureSite() {
  const state = { price: '$10', stock: 'In stock', clock: '2026-03-03 10:00:00', jsPrice: '$100' };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/js') {
      // Content built by JavaScript: invisible to a plain HTTP fetch, visible to a rendered one.
      res.end(`<html><body><h1>Rendered page</h1><div id="app"></div><script>
        document.getElementById('app').textContent = 'Plan price: ${state.jsPrice} per month';
      </script></body></html>`);
    } else if (req.url === '/clock') {
      res.end(`<html><body><h1>Status</h1><p>Last updated: ${state.clock}</p><p>All systems operational</p></body></html>`);
    } else {
      res.end(`<html><body><h1>Gaming Console</h1><p>Price: ${state.price}</p><p>${state.stock}</p></body></html>`);
    }
  });
  return { ...(await listen(server)), state };
}

/** A local webhook receiver that records everything it is sent. */
export async function startReceiver() {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200).end('ok');
    });
  });
  return { ...(await listen(server)), received };
}

/** Starts the real app (API + scheduler + worker) as a child process against the e2e database. */
export async function startApp(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void> }> {
  const probe = await listen(http.createServer());
  const port = new URL(probe.url).port;
  await probe.close();

  const child: ChildProcess = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: root,
    env: { ...process.env, ...env, PORT: port, DATABASE_URL: e2eDatabaseUrl(), LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`App exited early with code ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('App did not become healthy in 30s');
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
