import { createHash } from 'node:crypto';

/**
 * Makes two fetches of the same page comparable: Unicode-normalises, collapses
 * runs of whitespace inside lines, and drops blank lines. Line structure is kept
 * because the diff works line by line.
 */
export function normalizeText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
