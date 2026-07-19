/**
 * Read-only telemetry for the home screen: what has been corrected on this machine and how much
 * the server's response cache holds. Both are decoration, never a dependency — the home screen
 * must render fine with the server unreachable (standalone web dev, offline), so every failure
 * here resolves to null instead of throwing.
 */

export interface EditStats {
  documents: number;
  pages: number;
  /** content hash -> corrected page count, so every library card gets its badge in one request. */
  byDocument: Record<string, number>;
}

export interface CacheStats {
  entries: number;
  bytes: number;
}

export async function fetchEditStats(): Promise<EditStats | null> {
  try {
    const res = await fetch('/api/edits');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      documents: data.documents ?? 0,
      pages: data.pages ?? 0,
      byDocument: data.byDocument ?? {},
    };
  } catch {
    return null;
  }
}

export async function fetchCacheStats(): Promise<CacheStats | null> {
  try {
    const res = await fetch('/api/cache');
    if (!res.ok) return null;
    const data = await res.json();
    return { entries: data.entries ?? 0, bytes: data.bytes ?? 0 };
  } catch {
    return null;
  }
}
