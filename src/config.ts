import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://watchdog:watchdog@localhost:5432/watchdog'),
  PORT: z.coerce.number().int().default(3000),
  LLM_PROVIDER: z.enum(['auto', 'anthropic', 'ollama', 'mock']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-5-5'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2'),
  WEBHOOK_SECRET: z.string().default('dev-secret-change-me'),
  DEFAULT_WEBHOOK_URL: z.string().optional(),
  FETCH_MODE: z.enum(['auto', 'playwright', 'http']).default('auto'),
  ALLOW_PRIVATE_HOSTS: z.enum(['true', 'false']).default('false'),
  WORKER_POLL_MS: z.coerce.number().int().default(1000),
  SCHEDULER_POLL_MS: z.coerce.number().int().default(5000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().default(6),
  BACKOFF_BASE_MS: z.coerce.number().int().default(2000),
  BACKOFF_CAP_MS: z.coerce.number().int().default(10 * 60_000),
});

export type Config = ReturnType<typeof loadConfig>;

/** Reads and validates environment variables once; empty strings count as unset. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const e = EnvSchema.parse(cleaned);
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    llmProvider: e.LLM_PROVIDER,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
    ollamaUrl: e.OLLAMA_URL,
    ollamaModel: e.OLLAMA_MODEL,
    webhookSecret: e.WEBHOOK_SECRET,
    defaultWebhookUrl: e.DEFAULT_WEBHOOK_URL,
    fetchMode: e.FETCH_MODE,
    allowPrivateHosts: e.ALLOW_PRIVATE_HOSTS === 'true',
    workerPollMs: e.WORKER_POLL_MS,
    schedulerPollMs: e.SCHEDULER_POLL_MS,
    jobMaxAttempts: e.JOB_MAX_ATTEMPTS,
    webhookMaxAttempts: e.WEBHOOK_MAX_ATTEMPTS,
    backoff: { baseMs: e.BACKOFF_BASE_MS, capMs: e.BACKOFF_CAP_MS },
  };
}
