import { describe, expect, it } from 'vitest';
import { diffLines, leadingContext } from '../../src/text/diff.js';
import { htmlToText } from '../../src/text/html.js';
import { hashText, normalizeText } from '../../src/text/normalize.js';

describe('normalizeText', () => {
  it('collapses whitespace, drops blank lines and zero-width characters', () => {
    expect(normalizeText('  Hello   \t world \r\n\r\n\n  next​ line  ')).toBe('Hello world\nnext line');
  });

  it('applies Unicode NFKC so look-alike forms hash the same', () => {
    expect(normalizeText('１０％ off')).toBe('10% off');
  });

  it('hashes equal text equally and different text differently', () => {
    expect(hashText('a')).toBe(hashText('a'));
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('diffLines', () => {
  it('returns nothing for identical text', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual({ added: [], removed: [] });
  });

  it('finds added and removed lines in the middle', () => {
    const d = diffLines('a\nold\nc', 'a\nnew\nextra\nc');
    expect(d.removed).toEqual(['old']);
    expect(d.added).toEqual(['new', 'extra']);
  });

  it('treats a moved line as one removal plus one addition', () => {
    const d = diffLines('a\nb\nc', 'b\nc\na');
    expect(d.removed).toEqual(['a']);
    expect(d.added).toEqual(['a']);
  });

  it('handles empty before (first content) and empty after', () => {
    expect(diffLines('', 'x\ny')).toEqual({ added: ['x', 'y'], removed: [] });
    expect(diffLines('x', '')).toEqual({ added: [], removed: ['x'] });
  });

  it('falls back to a set difference for very large diffs instead of exhausting memory', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `before ${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `after ${i}`).join('\n');
    const d = diffLines(before, after);
    expect(d.removed).toHaveLength(3000);
    expect(d.added).toHaveLength(3000);
  });
});

describe('leadingContext', () => {
  it('returns the unchanged lines above the first change', () => {
    const after = 'Refund Policy\nIntro\n14-day guarantee\nFooter';
    const diff = diffLines('Refund Policy\nIntro\n30-day guarantee\nFooter', after);
    expect(leadingContext(after, diff)).toEqual(['Refund Policy', 'Intro']);
  });

  it('returns nothing when the change is on the first line', () => {
    const diff = diffLines('a', 'b');
    expect(leadingContext('b', diff)).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('removes scripts, styles and comments, keeps visible text, and decodes entities', () => {
    const html = '<style>p{}</style><!-- hidden --><h1>Price</h1><p>$5 &amp; free&nbsp;shipping</p><script>alert(1)</script>';
    expect(normalizeText(htmlToText(html))).toBe('Price\n$5 & free shipping');
  });

  it('turns block tags into line breaks so the diff is line-based', () => {
    expect(normalizeText(htmlToText('<li>one</li><li>two</li>'))).toBe('one\ntwo');
  });
});
