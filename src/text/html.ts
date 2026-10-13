const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Cheap HTML -> text for the plain-fetch fallback (no JavaScript is executed).
 * Not a full parser: it removes script/style/comment blocks, turns block-level
 * tags into line breaks, strips the remaining tags and decodes common entities.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(p|div|br|li|ul|ol|tr|td|th|h[1-6]|section|article|header|footer|nav|table|form)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent: string) => {
      if (ent.startsWith('#x')) return String.fromCodePoint(parseInt(ent.slice(2), 16));
      if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10));
      return ENTITIES[ent.toLowerCase()] ?? match;
    });
}
