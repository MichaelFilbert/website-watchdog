import type { Usage } from './types.js';

/** USD per million tokens. These are estimates for budgeting, not billing data; override via env if prices change. */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': {
    input: Number(process.env.ANTHROPIC_PRICE_INPUT_PER_MTOK ?? 1),
    output: Number(process.env.ANTHROPIC_PRICE_OUTPUT_PER_MTOK ?? 5),
  },
};

/** Local and mock providers cost nothing; unknown models are treated as free rather than guessed. */
export function estimateCostUsd(model: string, usage: Usage): number {
  const price = PRICES_PER_MTOK[model];
  if (!price) return 0;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
