import { formatBytes } from '../lib/pdf';
import type { DocFile } from '../lib/types';

interface Props {
  docs: DocFile[];
  active: DocFile;
  /** The configured page range, verbatim. Empty means the whole document. */
  pages: string;
  /** True for a couple of seconds after a run finishes — see the `done` chip. */
  flash: boolean;
  onSelect: (id: string) => void;
}

export function DocBar({ docs, active, pages, flash, onSelect }: Props) {
  const result = active.result;
  const position = docs.findIndex((d) => d.id === active.id) + 1;
  /** A range that silently covers less than the document is the dangerous kind of quiet. */
  const partial = pages.trim() !== '' && active.pageCount > 1;

  return (
    <div className="docbar">
      <span className="file-name" title={active.name}>📄 {active.name}</span>

      {/* A run whose result is cached and identical changes nothing on screen — which is
          indistinguishable from a button that did nothing. Say it ran. */}
      {flash && <span className="chip done">✓ run complete</span>}

      {/* Only part of the document was read, and the config panel is closed. Without this the
          only evidence is a small page count, and a 51-page book quietly processed as 1 page
          looks exactly like a 1-page book. */}
      {partial && (
        <span
          className="chip range"
          title={
            `Only pages “${pages}” of this ${active.pageCount}-page document are being processed. ` +
            `Clear the Pages field in Configure to read the whole document.`
          }
        >
          ⚠ pages {pages} of {active.pageCount}
        </span>
      )}

      {result?.cached && (
        <span
          className="chip cached"
          title="Served from the server's disk cache — this document was already processed, so no API call was made and nothing was billed. Use “Force re-run” to pay for a fresh one."
        >
          ⚡ cached · free
        </span>
      )}

      {result && (
        <>
          <span className="chip time">⏱ {(result.processingMs / 1000).toFixed(2)}s</span>
          <span className="chip pages">▤ {result.pagesProcessed}</span>
          <span className="chip tokens">
            {result.tokens != null ? `Tt ${result.tokens.toLocaleString()}` : 'Tt n/a'}
          </span>
          {result.chunks != null && result.chunks > 1 && (
            <span
              className="chip chunks"
              title={
                `The document was split into ${result.chunks} requests and stitched back together. ` +
                `Large single OCR uploads can lose their connection, so only the pages being ` +
                `OCR'd are sent, a few MB at a time. Page numbers are remapped to the original document.`
              }
            >
              ⑂ {result.chunks} chunks
            </span>
          )}
        </>
      )}
      <span className="chip size">⛁ {formatBytes(active.sizeBytes)}</span>

      <span className="spacer" />

      <label className="switcher">
        <span className="muted">File {position} of {docs.length}</span>
        <select value={active.id} onChange={(e) => onSelect(e.target.value)} aria-label="Switch document">
          {docs.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.name}
              {doc.result ? ' ✓' : doc.running ? ' …' : ''}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
