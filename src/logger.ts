import { pino } from 'pino';

export type Logger = pino.Logger;

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
});
