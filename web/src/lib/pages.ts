/**
 * "1-4,8" -> [0,1,2,3,7]. The UI is 1-based; page indices are 0-based.
 * Returns null for an empty range, meaning "every page".
 *
 * The server parses the same syntax for the single-request path (server/src/mistral.ts).
 * This copy exists because chunking decides *client-side* which pages to extract, before
 * anything is sent.
 */
export function parsePageRange(spec: string): number[] | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  const pages = new Set<number>();
  for (const part of trimmed.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;

    const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      if (start < 1 || end < start) throw new Error(`Invalid page range “${chunk}”.`);
      for (let p = start; p <= end; p++) pages.add(p - 1);
      continue;
    }

    const single = chunk.match(/^(\d+)$/);
    if (!single || Number(single[1]) < 1) throw new Error(`Invalid page “${chunk}”. Use syntax like “1-4,8”.`);
    pages.add(Number(single[1]) - 1);
  }

  return [...pages].sort((a, b) => a - b);
}
