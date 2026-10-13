import { CATEGORIES } from '../src/llm/types.js';
import type { Category, Severity } from '../src/llm/types.js';

export interface Label {
  meaningful: boolean;
  category: Category;
  severity: Severity;
}

export interface CaseResult {
  id: string;
  expected: Label;
  /** null when the provider failed (counts as wrong). */
  predicted: Label | null;
  source: 'prefilter' | 'llm' | 'error';
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface CategoryScore {
  category: Category;
  support: number;
  precision: number | null;
  recall: number | null;
}

export interface Summary {
  total: number;
  categoryAccuracy: number;
  meaningfulAccuracy: number;
  /** Severity accuracy among cases whose category was predicted correctly and are meaningful. */
  severityAccuracy: number | null;
  perCategory: CategoryScore[];
  avgLatencyMs: number;
  totalCostUsd: number;
  resolvedByPrefilter: number;
  errors: number;
}

const ratio = (num: number, den: number) => (den === 0 ? null : num / den);

export function summarize(results: CaseResult[]): Summary {
  const total = results.length;
  const categoryHits = results.filter((r) => r.predicted?.category === r.expected.category).length;
  const meaningfulHits = results.filter((r) => r.predicted?.meaningful === r.expected.meaningful).length;
  const severityPool = results.filter((r) => r.expected.meaningful && r.predicted?.category === r.expected.category);
  const severityHits = severityPool.filter((r) => r.predicted?.severity === r.expected.severity).length;

  const perCategory = CATEGORIES.map((category): CategoryScore => {
    const tp = results.filter((r) => r.expected.category === category && r.predicted?.category === category).length;
    const predictedCount = results.filter((r) => r.predicted?.category === category).length;
    const support = results.filter((r) => r.expected.category === category).length;
    return { category, support, precision: ratio(tp, predictedCount), recall: ratio(tp, support) };
  });

  const llmCalls = results.filter((r) => r.source !== 'prefilter');
  return {
    total,
    categoryAccuracy: categoryHits / total,
    meaningfulAccuracy: meaningfulHits / total,
    severityAccuracy: ratio(severityHits, severityPool.length),
    perCategory,
    avgLatencyMs: llmCalls.length ? llmCalls.reduce((s, r) => s + r.latencyMs, 0) / llmCalls.length : 0,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
    resolvedByPrefilter: results.filter((r) => r.source === 'prefilter').length,
    errors: results.filter((r) => r.source === 'error').length,
  };
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);

export function renderReport(opts: { provider: string; model: string; summary: Summary; results: CaseResult[]; threshold: number; date: Date }): string {
  const { summary: s, results } = opts;
  const passed = s.categoryAccuracy >= opts.threshold;
  const misses = results.filter((r) => r.predicted?.category !== r.expected.category);
  const lines = [
    `# Eval report: ${opts.provider} / ${opts.model}`,
    '',
    `Run: ${opts.date.toISOString()}  |  Cases: ${s.total}  |  Gate: category accuracy >= ${pct(opts.threshold)} -> **${passed ? 'PASS' : 'FAIL'}**`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Category accuracy | ${pct(s.categoryAccuracy)} |`,
    `| Meaningful (yes/no) accuracy | ${pct(s.meaningfulAccuracy)} |`,
    `| Severity accuracy (meaningful, category correct) | ${pct(s.severityAccuracy)} |`,
    `| Avg latency per LLM call | ${s.avgLatencyMs.toFixed(0)} ms |`,
    `| Total cost (estimated) | $${s.totalCostUsd.toFixed(4)} |`,
    `| Resolved by deterministic pre-filter (no LLM call) | ${s.resolvedByPrefilter} / ${s.total} |`,
    `| Provider errors | ${s.errors} |`,
    '',
    '| Category | Support | Precision | Recall |',
    '| --- | --- | --- | --- |',
    ...s.perCategory.map((c) => `| ${c.category} | ${c.support} | ${pct(c.precision)} | ${pct(c.recall)} |`),
    '',
    `## Misses (${misses.length})`,
    '',
  ];
  if (misses.length === 0) lines.push('None.');
  else {
    lines.push('| Case | Expected | Got | Source |', '| --- | --- | --- | --- |');
    for (const m of misses) lines.push(`| ${m.id} | ${m.expected.category} | ${m.predicted?.category ?? `error: ${m.error ?? ''}`} | ${m.source} |`);
  }
  return lines.join('\n') + '\n';
}
