/**
 * Client for the durable correction store (server/src/edits.ts).
 *
 * IndexedDB already keeps edits for THIS browser; this keeps them for the document. A correction is
 * the one thing here nobody can regenerate — the OCR can be re-run, a figure re-drawn, a second
 * opinion re-asked, but the sentence a person fixed by hand exists only because they typed it. So it
 * is written through to disk, keyed by the document's content hash, and survives a cleared browser,
 * a different machine, or the same scan dropped in again months later.
 *
 * Best-effort by design: the editor must never block or lose work because the server is unreachable.
 * A failed write is surfaced to the caller, and the local session still holds the edit.
 */

/** page index (0-based) -> corrected markdown. */
export type EditMap = Record<string, string>;

/** Every stored correction for a document, or `{}` when there are none / the server is unreachable. */
export async function fetchEdits(key: string): Promise<EditMap> {
  try {
    const res = await fetch(`/api/edits/${key}`);
    if (!res.ok) return {};
    const data = (await res.json()) as { pages?: EditMap };
    return data.pages ?? {};
  } catch {
    return {}; // offline / standalone: the local session is still authoritative for this browser
  }
}

/** Persist one page's correction. `markdown === null` reverts that page to the OCR original. */
export async function saveEdit(key: string, pageIndex: number, markdown: string | null): Promise<void> {
  const res = await fetch(`/api/edits/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageIndex, markdown }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
    throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}.`);
  }
}
