import { z } from 'zod';

export const CATEGORIES = ['price', 'availability', 'policy', 'content', 'outage', 'noise'] as const;
export const SEVERITIES = ['low', 'medium', 'high'] as const;

export const ClassificationSchema = z
  .object({
    meaningful: z.boolean(),
    category: z.enum(CATEGORIES),
    severity: z.enum(SEVERITIES),
    summary: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine((c) => c.category !== 'noise' || !c.meaningful, {
    message: 'category "noise" cannot be marked meaningful',
    path: ['meaningful'],
  });

export type Classification = z.infer<typeof ClassificationSchema>;
export type Category = (typeof CATEGORIES)[number];
export type Severity = (typeof SEVERITIES)[number];

/** JSON Schema handed to providers that support structured output (tool input / Ollama format). */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    meaningful: { type: 'boolean', description: 'true if a human would want to be told about this change' },
    category: { type: 'string', enum: [...CATEGORIES] },
    severity: { type: 'string', enum: [...SEVERITIES] },
    summary: { type: 'string', maxLength: 200, description: 'One plain sentence describing what changed' },
  },
  required: ['meaningful', 'category', 'severity', 'summary'],
  additionalProperties: false,
} as const;

export interface ClassifyInput {
  url: string;
  /** Lines present now but not before (already noise-filtered). */
  added: string[];
  /** Lines present before but gone now. */
  removed: string[];
  /** Unchanged lines just above the change (headings), for orientation only. */
  context?: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifyResult {
  classification: Classification;
  usage: Usage;
}

export interface ClassifyOptions {
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'ollama' | 'mock';
  readonly model: string;
  classify(input: ClassifyInput, options?: ClassifyOptions): Promise<ClassifyResult>;
}

export type LlmErrorKind = 'timeout' | 'rate_limit' | 'refusal' | 'malformed' | 'unavailable' | 'error';

/** Every provider failure is mapped onto one of these so callers can decide what to do. */
export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  /** A refusal will not change on retry; everything else might. */
  get retryable(): boolean {
    return this.kind !== 'refusal';
  }
}
