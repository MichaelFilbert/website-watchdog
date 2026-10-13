import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, parseRetryAfterMs } from '../../src/llm/anthropic.js';
import type { AnthropicLike } from '../../src/llm/anthropic.js';
import { classifyAndLog } from '../../src/llm/classify.js';
import type { LlmCallRecord } from '../../src/llm/classify.js';
import { estimateCostUsd } from '../../src/llm/cost.js';
import { MockProvider } from '../../src/llm/mock.js';
import { OllamaProvider } from '../../src/llm/ollama.js';
import { parseClassificationText, validateClassification } from '../../src/llm/parse.js';
import { LlmError } from '../../src/llm/types.js';

const valid = { meaningful: true, category: 'price', severity: 'high', summary: 'Price rose from $29 to $39.' };
const input = { url: 'https://shop.test', added: ['Price $39'], removed: ['Price $29'] };

describe('structured output validation (zod)', () => {
  it('accepts a valid classification', () => {
    expect(validateClassification(valid)).toEqual(valid);
  });

  it.each([
    ['unknown category', { ...valid, category: 'spam' }],
    ['unknown severity', { ...valid, severity: 'critical' }],
    ['missing field', { meaningful: true, category: 'price', severity: 'low' }],
    ['wrong type', { ...valid, meaningful: 'yes' }],
    ['summary over 200 chars', { ...valid, summary: 'x'.repeat(201) }],
    ['empty summary', { ...valid, summary: '  ' }],
    ['extra field', { ...valid, confidence: 0.9 }],
    ['noise marked meaningful', { ...valid, category: 'noise' }],
  ])('rejects %s as malformed', (_name, value) => {
    expect(() => validateClassification(value)).toThrowError(expect.objectContaining({ kind: 'malformed' }));
  });

  it('extracts JSON from fenced or chatty model text', () => {
    const text = 'Sure! Here you go:\n```json\n' + JSON.stringify(valid) + '\n```';
    expect(parseClassificationText(text)).toEqual(valid);
  });

  it.each(['', 'I cannot do that', '{"meaningful": tru', '{broken json}'])('rejects non-JSON text %j as malformed', (text) => {
    expect(() => parseClassificationText(text)).toThrowError(expect.objectContaining({ kind: 'malformed' }));
  });
});

function anthropicStub(impl: () => Promise<unknown>): AnthropicLike {
  return { messages: { create: vi.fn(impl) as unknown as AnthropicLike['messages']['create'] } };
}
const message = (over: Partial<Anthropic.Message>): Anthropic.Message =>
  ({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 }, ...over }) as Anthropic.Message;

describe('AnthropicProvider', () => {
  it('forces the tool, validates the tool input and reports token usage', async () => {
    const stub = anthropicStub(() => Promise.resolve(message({ content: [{ type: 'tool_use', id: 't', name: 'report_change', input: valid }] as Anthropic.ContentBlock[] })));
    const result = await new AnthropicProvider('claude-haiku-5-5', stub).classify(input);
    expect(result.classification).toEqual(valid);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    const [body, options] = vi.mocked(stub.messages.create).mock.calls[0]!;
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'report_change' });
    expect(options).toMatchObject({ maxRetries: 0 });
  });

  it('maps a refusal stop reason to a non-retryable refusal', async () => {
    const stub = anthropicStub(() => Promise.resolve(message({ stop_reason: 'refusal' as Anthropic.Message['stop_reason'] })));
    const err = await new AnthropicProvider('m', stub).classify(input).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'refusal', retryable: false });
  });

  it('treats a reply without a tool_use block as malformed', async () => {
    const stub = anthropicStub(() => Promise.resolve(message({ content: [{ type: 'text', text: 'hi', citations: null }] as Anthropic.ContentBlock[] })));
    await expect(new AnthropicProvider('m', stub).classify(input)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('treats a schema-violating tool input as malformed', async () => {
    const stub = anthropicStub(() => Promise.resolve(message({ content: [{ type: 'tool_use', id: 't', name: 'report_change', input: { ...valid, category: 'x' } }] as Anthropic.ContentBlock[] })));
    await expect(new AnthropicProvider('m', stub).classify(input)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('maps 429 to rate_limit and honours Retry-After seconds', async () => {
    const stub = anthropicStub(() => Promise.reject(new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers({ 'retry-after': '7' }))));
    const err = (await new AnthropicProvider('m', stub).classify(input).catch((e: unknown) => e)) as LlmError;
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(7000);
  });

  it('maps timeouts and 5xx to retryable errors', async () => {
    const timeout = anthropicStub(() => Promise.reject(new Anthropic.APIConnectionTimeoutError()));
    await expect(new AnthropicProvider('m', timeout).classify(input)).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    const overloaded = anthropicStub(() => Promise.reject(new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers())));
    await expect(new AnthropicProvider('m', overloaded).classify(input)).rejects.toMatchObject({ kind: 'unavailable', retryable: true });
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds, HTTP dates and garbage', () => {
    expect(parseRetryAfterMs('3')).toBe(3000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe('OllamaProvider', () => {
  const reply = (content: string, status = 200, headers: Record<string, string> = {}) =>
    (() => Promise.resolve(new Response(JSON.stringify({ message: { content }, prompt_eval_count: 50, eval_count: 20 }), { status, headers }))) as unknown as typeof fetch;

  it('parses a valid structured reply and reports tokens', async () => {
    const result = await new OllamaProvider('llama3.2', 'http://x', reply(JSON.stringify(valid))).classify(input);
    expect(result.classification).toEqual(valid);
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20 });
  });

  it('reports malformed model output', async () => {
    await expect(new OllamaProvider('m', 'http://x', reply('not json')).classify(input)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('maps 429 with Retry-After, and an unreachable server', async () => {
    await expect(new OllamaProvider('m', 'http://x', reply('', 429, { 'retry-after': '2' })).classify(input)).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 2000 });
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(new OllamaProvider('m', 'http://x', down).classify(input)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('maps an aborted request to timeout', async () => {
    const slow = (() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))) as unknown as typeof fetch;
    await expect(new OllamaProvider('m', 'http://x', slow).classify(input)).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('classifyAndLog (llm_calls logging)', () => {
  it('logs provider, model, latency, tokens, cost and outcome for a success', async () => {
    const records: LlmCallRecord[] = [];
    const stub = anthropicStub(() => Promise.resolve(message({ content: [{ type: 'tool_use', id: 't', name: 'report_change', input: valid }] as Anthropic.ContentBlock[], usage: { input_tokens: 1_000_000, output_tokens: 0 } as Anthropic.Usage })));
    await classifyAndLog(new AnthropicProvider('claude-haiku-5-5', stub), input, (r) => void records.push(r));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', outcome: 'ok', inputTokens: 1_000_000 });
    expect(records[0]!.costUsd).toBeGreaterThan(0);
    expect(records[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('logs failures too, with the outcome, and rethrows', async () => {
    const records: LlmCallRecord[] = [];
    const failing = new MockProvider(() => new LlmError('timeout', 'slow'));
    await expect(classifyAndLog(failing, input, (r) => void records.push(r))).rejects.toMatchObject({ kind: 'timeout' });
    expect(records[0]).toMatchObject({ provider: 'mock', outcome: 'timeout', error: 'slow' });
  });

  it('estimates zero cost for local and unknown models', () => {
    expect(estimateCostUsd('llama3.2', { inputTokens: 10_000, outputTokens: 10_000 })).toBe(0);
  });
});

describe('MockProvider', () => {
  it('is deterministic and returns valid classifications', async () => {
    const mock = new MockProvider();
    const a = await mock.classify(input);
    const b = await mock.classify(input);
    expect(a).toEqual(b);
    expect(validateClassification(a.classification)).toEqual(a.classification);
    expect(a.classification.category).toBe('price');
  });
});
