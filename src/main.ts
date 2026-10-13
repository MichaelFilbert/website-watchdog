import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createFetcher } from './fetch/index.js';
import { createHandlers } from './jobs/handlers.js';
import { startScheduler } from './jobs/scheduler.js';
import { selectProvider } from './llm/select.js';
import { logger } from './logger.js';
import { Worker } from './queue/worker.js';
import { buildServer } from './api/server.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);

if (config.webhookSecret === 'dev-secret-change-me') logger.warn('WEBHOOK_SECRET is the default dev value; set your own');

const applied = await migrate(db);
if (applied.length) logger.info({ applied }, 'migrations applied');

const llm = await selectProvider(config, logger);
const fetcher = createFetcher(config, logger);
const worker = new Worker({
  db,
  log: logger,
  backoff: config.backoff,
  pollMs: config.workerPollMs,
  handlers: createHandlers({ db, config, fetcher, llm, log: logger }),
});
const app = buildServer({ db, config, logger });

worker.start();
const stopScheduler = startScheduler(db, logger, config.schedulerPollMs);
await app.listen({ port: config.port, host: '0.0.0.0' });
logger.info(`dashboard: http://localhost:${config.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  await app.close();
  await stopScheduler();
  await worker.stop();
  await fetcher.close();
  await db.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
