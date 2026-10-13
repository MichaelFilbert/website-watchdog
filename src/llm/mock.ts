import { LlmError } from './types.js';
import type { Category, ClassifyInput, ClassifyResult, LlmProvider, Severity } from './types.js';

/**
 * Deterministic keyword heuristic used by tests and offline runs.
 * It is NOT a model: scoring it in the eval proves the pipeline and the gate work,
 * not that the classification is good. Behaviour can be forced with `failWith` for error-path tests.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-heuristic-v1';
  calls = 0;

  constructor(private readonly failWith?: () => LlmError | undefined) {}

  classify(input: ClassifyInput): Promise<ClassifyResult> {
    this.calls++;
    const failure = this.failWith?.();
    if (failure) return Promise.reject(failure);

    const added = input.added.join(' ');
    const removed = input.removed.join(' ');
    const { category, severity } = decide(added, removed, input.context?.join(' ') ?? '');
    const meaningful = category !== 'noise';
    const summary = summarize(category, input).slice(0, 200);
    const inputTokens = Math.ceil((added.length + removed.length + input.url.length) / 4);
    return Promise.resolve({
      classification: { meaningful, category, severity: meaningful ? severity : 'low', summary },
      usage: { inputTokens, outputTokens: Math.ceil(summary.length / 4) },
    });
  }
}

const OUTAGE = /\b(outage|incident|degraded|service unavailable|temporarily unavailable|under maintenance|scheduled maintenance|we.?re down|503|502|major disruption|investigating)\b/i;
const AVAILABILITY = /\b(in stock|out of stock|sold out|back in stock|waitlist|wait list|few left|only \d+ left|pre-?order|no longer available|now available|spots? (?:left|available)|fully booked|available)\b/i;
const POLICY = /\b(terms|privacy|policy|refund|return window|returns?|warranty|cancellations?|gdpr|cookies|shipping (?:fee|cost|time)|liability)\b/i;
const MONEY = /(?:[$€£]|\bUSD\b|\bAUD\b)\s?\d[\d,.]*|\d[\d,.]*\s?(?:%\s?off|per month|\/mo|\/month)/gi;

function prices(text: string): number[] {
  return (text.match(MONEY) ?? []).map((m) => Number(m.replace(/[^\d.]/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
}

function decide(added: string, removed: string, context: string): { category: Category; severity: Severity } {
  const all = `${added} ${removed} ${context}`;
  if (OUTAGE.test(added)) return { category: 'outage', severity: 'high' };

  const before = prices(removed);
  const after = prices(added);
  if (before.length > 0 && after.length > 0 && before.join() !== after.join()) {
    const change = Math.abs(after[0]! - before[0]!) / before[0]!;
    return { category: 'price', severity: change >= 0.2 ? 'high' : change >= 0.05 ? 'medium' : 'low' };
  }
  if (AVAILABILITY.test(all)) return { category: 'availability', severity: /sold out|out of stock|no longer|fully booked/i.test(added) ? 'high' : 'medium' };
  if (POLICY.test(all)) return { category: 'policy', severity: 'medium' };
  if (after.length !== before.length && (after.length > 0 || before.length > 0)) return { category: 'price', severity: 'medium' };

  // Same letters and digits once punctuation and spacing are stripped = cosmetic edit.
  const letters = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return letters(added) === letters(removed) ? { category: 'noise', severity: 'low' } : { category: 'content', severity: 'low' };
}

function summarize(category: Category, input: ClassifyInput): string {
  const first = (input.added[0] ?? input.removed[0] ?? '').slice(0, 120);
  return category === 'noise' ? `Trivial change ignored: "${first}"` : `${category} change detected: "${first}"`;
}
