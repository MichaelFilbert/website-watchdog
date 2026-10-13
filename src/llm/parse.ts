import { ClassificationSchema, LlmError } from './types.js';
import type { Classification } from './types.js';

/** Pulls the first JSON object out of model text (handles ```json fences and chatter around it). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new LlmError('malformed', 'No JSON object found in model output');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LlmError('malformed', 'Model output is not valid JSON');
  }
}

/** Validates an already-parsed value. Never trust the model, even when it used a tool schema. */
export function validateClassification(value: unknown): Classification {
  const parsed = ClassificationSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new LlmError('malformed', `Output failed schema validation: ${detail}`);
  }
  return parsed.data;
}

export function parseClassificationText(text: string): Classification {
  return validateClassification(extractJsonObject(text));
}
