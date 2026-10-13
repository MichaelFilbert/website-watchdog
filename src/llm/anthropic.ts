import Anthropic from '@anthropic-ai/sdk';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.js';
import { validateClassification } from './parse.js';
import { CLASSIFICATION_JSON_SCHEMA, LlmError } from './types.js';
import type { ClassifyInput, ClassifyOptions, ClassifyResult, LlmProvider } from './types.js';

const TOOL_NAME = 'report_change';

/** The slice of the SDK we use, so tests can pass a stub instead of hitting the network. */
export interface AnthropicLike {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }): Promise<Anthropic.Message> };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;

  constructor(
    readonly model: string,
    private readonly client: AnthropicLike,
  ) {}

  static fromApiKey(apiKey: string, model: string): AnthropicProvider {
    return new AnthropicProvider(model, new Anthropic({ apiKey }));
  }

  async classify(input: ClassifyInput, options: ClassifyOptions = {}): Promise<ClassifyResult> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          tools: [
            {
              name: TOOL_NAME,
              description: 'Report the classification of the page change.',
              input_schema: CLASSIFICATION_JSON_SCHEMA as unknown as Anthropic.Tool.InputSchema,
            },
          ],
          // Forcing the tool means the reply is a JSON object matching the schema, not free text.
          tool_choice: { type: 'tool', name: TOOL_NAME },
          messages: [{ role: 'user', content: buildUserPrompt(input) }],
        },
        // maxRetries 0: retries belong to the job queue (visible, bounded, with backoff), not hidden in the SDK.
        { timeout: options.timeoutMs ?? 20_000, maxRetries: 0 },
      );
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (message.stop_reason === 'refusal') {
      throw new LlmError('refusal', 'The model refused to classify this change');
    }
    const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) throw new LlmError('malformed', 'Response contained no tool_use block');

    return {
      classification: validateClassification(toolUse.input),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

export function mapAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timeout', 'Anthropic request timed out');
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) return new LlmError('rate_limit', 'Anthropic rate limit hit', parseRetryAfterMs(retryAfterHeader(err.headers)));
    if (err.status === 529 || (err.status !== undefined && err.status >= 500)) {
      return new LlmError('unavailable', `Anthropic unavailable (HTTP ${err.status})`, parseRetryAfterMs(retryAfterHeader(err.headers)));
    }
    return new LlmError('error', `Anthropic API error (HTTP ${err.status}): ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('unavailable', `Anthropic connection error: ${err.message}`);
  return new LlmError('error', err instanceof Error ? err.message : String(err));
}

function retryAfterHeader(headers: unknown): string | null | undefined {
  if (headers && typeof (headers as Headers).get === 'function') return (headers as Headers).get('retry-after');
  if (headers && typeof headers === 'object') return (headers as Record<string, string>)['retry-after'];
  return undefined;
}

/** Retry-After is either seconds or an HTTP date. Returns undefined when absent or unusable. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
