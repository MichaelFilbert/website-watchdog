import { estimateCostUsd } from './cost.js';
import { LlmError } from './types.js';
import type { ClassifyInput, ClassifyOptions, ClassifyResult, LlmProvider } from './types.js';

export interface LlmCallRecord {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: 'ok' | 'malformed' | 'refusal' | 'timeout' | 'rate_limit' | 'error';
  error?: string;
}

export type CallLogger = (record: LlmCallRecord) => Promise<void> | void;

/**
 * Runs one classification and records it (success or failure) through `log`.
 * Errors are rethrown as LlmError after being logged.
 */
export async function classifyAndLog(
  provider: LlmProvider,
  input: ClassifyInput,
  log: CallLogger,
  options?: ClassifyOptions,
): Promise<ClassifyResult> {
  const started = performance.now();
  const base = { provider: provider.name, model: provider.model };
  try {
    const result = await provider.classify(input, options);
    await log({
      ...base,
      latencyMs: Math.round(performance.now() - started),
      ...result.usage,
      costUsd: estimateCostUsd(provider.model, result.usage),
      outcome: 'ok',
    });
    return result;
  } catch (err) {
    const llmError = err instanceof LlmError ? err : new LlmError('error', err instanceof Error ? err.message : String(err));
    const outcome = llmError.kind === 'unavailable' ? 'error' : llmError.kind;
    await log({
      ...base,
      latencyMs: Math.round(performance.now() - started),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      outcome,
      error: llmError.message,
    });
    throw llmError;
  }
}
