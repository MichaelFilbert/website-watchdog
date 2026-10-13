import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.js';
import { parseClassificationText } from './parse.js';
import { parseRetryAfterMs } from './anthropic.js';
import { CLASSIFICATION_JSON_SCHEMA, LlmError } from './types.js';
import type { ClassifyInput, ClassifyOptions, ClassifyResult, LlmProvider } from './types.js';

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama' as const;

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async classify(input: ClassifyInput, options: ClassifyOptions = {}): Promise<ClassifyResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Ollama constrains decoding to this JSON schema; we still validate the result ourselves.
          format: CLASSIFICATION_JSON_SCHEMA,
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(input) },
          ],
        }),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new LlmError('timeout', 'Ollama request timed out');
      }
      throw new LlmError('unavailable', `Ollama unreachable at ${this.baseUrl}: ${(err as Error).message}`);
    }

    if (res.status === 429) {
      throw new LlmError('rate_limit', 'Ollama returned 429', parseRetryAfterMs(res.headers.get('retry-after')));
    }
    if (!res.ok) {
      const kind = res.status >= 500 ? 'unavailable' : 'error';
      throw new LlmError(kind, `Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    let body: OllamaChatResponse;
    try {
      body = (await res.json()) as OllamaChatResponse;
    } catch {
      throw new LlmError('malformed', 'Ollama response body was not JSON');
    }
    return {
      classification: parseClassificationText(body.message?.content ?? ''),
      usage: { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 },
    };
  }
}

/** Returns true if Ollama answers and has the model pulled. Used for auto provider selection. */
export async function ollamaHasModel(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: { name: string; model?: string }[] };
    const wanted = model.includes(':') ? model : `${model}:latest`;
    return (body.models ?? []).some((m) => m.name === wanted || m.model === wanted || m.name === model);
  } catch {
    return false;
  }
}
