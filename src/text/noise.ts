import type { TextDiff } from './diff.js';

/**
 * Cheap, deterministic pre-filter. The idea: mask the parts of a line that change
 * on every page load (clock times, "5 minutes ago", visitor counters, tokens),
 * then see whether the added lines are just the removed lines in a new costume.
 * Prices, stock words and other substantive text are deliberately NOT masked.
 */

const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const VOLATILE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, // ISO date/time
  new RegExp(`\\b(?:\\d{1,2}\\s+${MONTHS}\\.?,?\\s+\\d{4}|${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})\\b`, 'gi'), // 3 March 2026 / March 3, 2026
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, // 03/03/2026
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?(?:\s?(?:utc|gmt|[a-z]{2,4}t))?\b/gi, // 14:05:33, 2:05 PM EST
  /\b(?:just now|a few seconds ago|an? (?:second|minute|hour|day) ago|\d+\s+(?:seconds?|mins?|minutes?|hours?|days?|weeks?)\s+ago)\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuid
  /\b[0-9a-f]{16,}\b/gi, // long hex: build ids, csrf tokens
  // counters: "1,204 people viewing", "views: 52", "3 users online"
  /\b[\d,.]+\s*(?:\+\s*)?(?:views?|visitors?|visits?|users? online|people (?:viewing|watching|online)|viewing now|watching|likes?|shares?|downloads?|comments?|members?|reviews?|ratings?)\b/gi,
  /\b(?:views?|visitors?|visits?|likes?|shares?|downloads?|page views|online now|viewers)\s*[:\-]?\s*[\d,.]+\b/gi,
  /(?:\bcopyright|©)\s*(?:\(c\)\s*)?\d{4}(?:\s*[-–]\s*\d{4})?/gi,
];

const AD_LINE = /^(?:ads?|advertisement|sponsored(?: content| links?)?|promoted|recommended for you|you may also like)\b/i;

export function maskVolatile(line: string): string {
  let out = line;
  for (const pattern of VOLATILE_PATTERNS) out = out.replace(pattern, '#');
  return out.replace(/#(?:\s*#)+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface NoiseVerdict {
  /** True when nothing substantive is left, so the LLM does not need to be asked. */
  isNoise: boolean;
  reason: string;
  /** The lines the LLM should look at (everything that is not explained by noise). */
  added: string[];
  removed: string[];
}

export function filterNoise(diff: TextDiff): NoiseVerdict {
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return { isNoise: true, reason: 'no textual difference', added: [], removed: [] };
  }

  // 1. Pair each added line with a removed line that is identical once volatile
  //    tokens are masked; paired lines cancel out.
  const unmatchedRemoved = new Map<string, number[]>();
  diff.removed.forEach((line, index) => {
    const key = maskVolatile(line);
    unmatchedRemoved.set(key, [...(unmatchedRemoved.get(key) ?? []), index]);
  });
  const matchedRemoved = new Set<number>();
  const addedLeft: string[] = [];
  for (const line of diff.added) {
    const partner = unmatchedRemoved.get(maskVolatile(line))?.shift();
    if (partner === undefined) addedLeft.push(line);
    else matchedRemoved.add(partner);
  }
  const removedLeft = diff.removed.filter((_, index) => !matchedRemoved.has(index));
  const cancelled = matchedRemoved.size;

  // 2. Drop lines that are only a masked token (a bare timestamp or counter) or an ad slot.
  const substantive = (line: string) => !AD_LINE.test(line.trim()) && !/^[#\s\p{P}]*$/u.test(maskVolatile(line));
  const added = addedLeft.filter(substantive);
  const removed = removedLeft.filter(substantive);

  if (added.length === 0 && removed.length === 0) {
    const reason = cancelled > 0 ? 'only timestamps/counters/tokens changed' : 'only ad slots or bare volatile values changed';
    return { isNoise: true, reason, added, removed };
  }
  return { isNoise: false, reason: 'substantive lines remain', added, removed };
}
