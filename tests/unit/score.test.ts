import { describe, expect, it } from 'vitest';
import { renderReport, summarize } from '../../evals/score.js';
import type { CaseResult } from '../../evals/score.js';

const label = (category: CaseResult['expected']['category'], meaningful = category !== 'noise') => ({ meaningful, category, severity: 'low' as const });
const result = (id: string, expected: CaseResult['expected'], predicted: CaseResult['expected'] | null, extra: Partial<CaseResult> = {}): CaseResult => ({
  id,
  expected,
  predicted,
  source: predicted ? 'llm' : 'error',
  latencyMs: 100,
  costUsd: 0.001,
  ...extra,
});

describe('eval scoring', () => {
  const results = [
    result('a', label('price'), label('price')),
    result('b', label('price'), label('noise')),
    result('c', label('noise'), label('noise'), { source: 'prefilter', latencyMs: 0, costUsd: 0 }),
    result('d', label('policy'), null),
  ];
  const s = summarize(results);

  it('computes accuracy, treating provider errors as wrong', () => {
    expect(s.categoryAccuracy).toBe(0.5);
    expect(s.errors).toBe(1);
    expect(s.resolvedByPrefilter).toBe(1);
  });

  it('computes per-category precision and recall', () => {
    const price = s.perCategory.find((c) => c.category === 'price')!;
    expect(price).toMatchObject({ support: 2, precision: 1, recall: 0.5 });
    const noise = s.perCategory.find((c) => c.category === 'noise')!;
    expect(noise.precision).toBe(0.5);
    expect(s.perCategory.find((c) => c.category === 'outage')!.precision).toBeNull();
  });

  it('averages latency over LLM calls only and sums cost', () => {
    expect(s.avgLatencyMs).toBe(100);
    expect(s.totalCostUsd).toBeCloseTo(0.003);
  });

  it('renders PASS/FAIL against the threshold and lists misses', () => {
    const report = renderReport({ provider: 'mock', model: 'm', summary: s, results, threshold: 0.8, date: new Date(0) });
    expect(report).toContain('**FAIL**');
    expect(report).toContain('| b | price | noise | llm |');
  });
});
