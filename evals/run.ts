import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadConfig, loadDotEnvIfPresent } from '../src/config.js';
import { classifyAndLog } from '../src/llm/classify.js';
import type { LlmCallRecord } from '../src/llm/classify.js';
import { selectProvider } from '../src/llm/select.js';
import { CATEGORIES, LlmError, SEVERITIES } from '../src/llm/types.js';
import { logger } from '../src/logger.js';
import { diffLines, leadingContext } from '../src/text/diff.js';
import { filterNoise } from '../src/text/noise.js';
import { normalizeText } from '../src/text/normalize.js';
import { renderReport, summarize } from './score.js';
import type { CaseResult, Label } from './score.js';

const DatasetSchema = z.object({
  cases: z.array(
    z.object({
      id: z.string(),
      before: z.string(),
      after: z.string(),
      expected: z.object({ meaningful: z.boolean(), category: z.enum(CATEGORIES), severity: z.enum(SEVERITIES) }),
    }),
  ),
});

// Same neutral URL for every case: case ids ("policy-01") contain the expected label,
// so putting them in the prompt would leak the answer to the model.
const EVAL_PAGE_URL = 'https://shop.example.com/page';

loadDotEnvIfPresent();

const providerArg = process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1];
const provider = providerArg ?? process.env.EVAL_PROVIDER ?? 'mock';
const threshold = Number(process.env.EVAL_MIN_ACCURACY ?? 0.8);

const config = loadConfig({ ...process.env, LLM_PROVIDER: provider });
const llm = await selectProvider(config, logger);
const dataset = DatasetSchema.parse(JSON.parse(await readFile(new URL('./dataset.json', import.meta.url), 'utf8')));

const results: CaseResult[] = [];
for (const testCase of dataset.cases) {
  const after = normalizeText(testCase.after);
  const diff = diffLines(normalizeText(testCase.before), after);
  const verdict = filterNoise(diff);

  if (verdict.isNoise) {
    const predicted: Label = { meaningful: false, category: 'noise', severity: 'low' };
    results.push({ id: testCase.id, expected: testCase.expected, predicted, source: 'prefilter', latencyMs: 0, costUsd: 0 });
    continue;
  }

  const calls: LlmCallRecord[] = [];
  try {
    const { classification } = await classifyWithOneRateLimitRetry(() =>
      classifyAndLog(llm, { url: EVAL_PAGE_URL, added: verdict.added, removed: verdict.removed, context: leadingContext(after, diff) }, (r) => void calls.push(r)),
    );
    const { meaningful, category, severity } = classification;
    results.push({
      id: testCase.id,
      expected: testCase.expected,
      predicted: { meaningful, category, severity },
      source: 'llm',
      latencyMs: sum(calls, 'latencyMs'),
      costUsd: sum(calls, 'costUsd'),
    });
  } catch (err) {
    results.push({
      id: testCase.id,
      expected: testCase.expected,
      predicted: null,
      source: 'error',
      latencyMs: sum(calls, 'latencyMs'),
      costUsd: sum(calls, 'costUsd'),
      error: (err as Error).message.slice(0, 80),
    });
  }
}

const summary = summarize(results);
const date = new Date();
const report = renderReport({ provider: llm.name, model: llm.model, summary, results, threshold, date });
await mkdir(new URL('./reports/', import.meta.url), { recursive: true });
const file = new URL(`./reports/${date.toISOString().replace(/[:.]/g, '-')}-${llm.name}.md`, import.meta.url);
await writeFile(file, report);

console.log(report);
console.log(`Report written to ${file.pathname}`);
if (summary.categoryAccuracy < threshold) {
  console.error(`FAIL: category accuracy ${(summary.categoryAccuracy * 100).toFixed(1)}% is below the ${(threshold * 100).toFixed(0)}% threshold`);
  process.exit(1);
}

function sum(calls: LlmCallRecord[], key: 'latencyMs' | 'costUsd'): number {
  return calls.reduce((total, c) => total + c[key], 0);
}

/** Hosted providers rate limit; honour Retry-After once before counting the case as an error. */
async function classifyWithOneRateLimitRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof LlmError && err.kind === 'rate_limit') {
      await new Promise((resolve) => setTimeout(resolve, Math.min(err.retryAfterMs ?? 5000, 30_000)));
      return run();
    }
    throw err;
  }
}
