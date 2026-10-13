export interface TextDiff {
  added: string[];
  removed: string[];
}

// Above this many cells the exact LCS table gets too big; fall back to set difference.
const MAX_LCS_CELLS = 4_000_000;

/**
 * Line-level diff. Trims the common prefix/suffix, then runs an LCS on what is
 * left. Returns only the lines that were added or removed (order preserved).
 */
export function diffLines(before: string, after: string): TextDiff {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length * midB.length > MAX_LCS_CELLS) return setDiff(midA, midB);

  // LCS length table, filled from the bottom right so we can walk it forwards.
  const n = midA.length;
  const m = midB.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removed.push(midA[i++]!);
    } else {
      added.push(midB[j++]!);
    }
  }
  while (i < n) removed.push(midA[i++]!);
  while (j < m) added.push(midB[j++]!);
  return { added, removed };
}

function setDiff(a: string[], b: string[]): TextDiff {
  const inA = new Set(a);
  const inB = new Set(b);
  return { removed: a.filter((l) => !inB.has(l)), added: b.filter((l) => !inA.has(l)) };
}

/**
 * Up to `count` unchanged lines just above the first changed line of the new text
 * (usually a heading such as "Refund Policy"). A changed line alone often cannot be
 * classified; its heading can.
 */
export function leadingContext(after: string, diff: TextDiff, count = 3): string[] {
  const lines = after === '' ? [] : after.split('\n');
  const changed = new Set(diff.added);
  const first = lines.findIndex((l) => changed.has(l));
  if (first <= 0) return [];
  return lines.slice(Math.max(0, first - count), first);
}
