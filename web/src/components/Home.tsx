import { useRef, useState } from 'react';
import { formatBytes } from '../lib/pdf';
import { formatWhen } from '../lib/format';
import type { LibraryMeta } from '../lib/store';
import type { DocFile } from '../lib/types';
import type { CacheStats, EditStats } from '../lib/telemetry';
import { IconDoc, IconPen, IconZap } from './icons';

interface Props {
  library: LibraryMeta[];
  /** Documents still open in the workspace while we're home — one click resumes them. */
  sessionDocs: DocFile[];
  editStats: EditStats | null;
  cacheStats: CacheStats | null;
  onFiles: (f: FileList) => void;
  onBrowse: () => void;
  onOpen: (key: string) => void;
  onDelete: (key: string) => void;
  onResume: (id: string) => void;
}

export function Home(props: Props) {
  // A counter, not a boolean: dragging across child elements fires leave/enter pairs, and a
  // boolean flickers the overlay off between them.
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const firstRun = props.library.length === 0 && props.sessionDocs.length === 0;

  return (
    <div
      className="home"
      onDragEnter={(e) => {
        e.preventDefault();
        if (depth.current++ === 0) setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        if (--depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) props.onFiles(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="drop-overlay">
          <div>Drop to add — PDF or image</div>
        </div>
      )}

      <section className="home-hero">
        <h2>Inspect a document</h2>
        <p className="muted">
          Drop a PDF or image anywhere on this page — then press <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> to
          run OCR.
        </p>
        <div className="home-drop">
          <button className="btn primary" onClick={props.onBrowse}>
            Add files
          </button>
          {firstRun && (
            <p className="muted">
              Every document you process is kept here, with its result — reopening one later is free and
              never calls the API.
            </p>
          )}
        </div>
      </section>

      <StatsStrip library={props.library} editStats={props.editStats} cacheStats={props.cacheStats} />

      {props.sessionDocs.length > 0 && (
        <section className="session-strip">
          <h3 className="home-section-title">Open in this session</h3>
          <div className="session-chips">
            {props.sessionDocs.map((d) => (
              <button key={d.id} className="btn session-chip" onClick={() => props.onResume(d.id)}>
                <IconDoc /> {d.name}
                <span className="muted">{d.running ? ' · running…' : d.result ? ' · ✓' : ' · not run'}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {props.library.length > 0 && (
        <section className="home-library">
          <div className="home-section-head">
            <h3 className="home-section-title">Processed documents ({props.library.length})</h3>
            <span className="muted">stored on this machine · reopen free, no API call</span>
          </div>
          <div className="lib-grid">
            {props.library.map((m) => (
              <LibraryCard
                key={m.key}
                meta={m}
                editedPages={props.editStats?.byDocument[m.key] ?? 0}
                open={props.sessionDocs.some((d) => d.libKey === m.key)}
                onOpen={() => props.onOpen(m.key)}
                onDelete={() => props.onDelete(m.key)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatsStrip({
  library,
  editStats,
  cacheStats,
}: {
  library: LibraryMeta[];
  editStats: EditStats | null;
  cacheStats: CacheStats | null;
}) {
  const pagesProcessed = library.reduce((sum, m) => sum + m.pagesProcessed, 0);
  const tiles: { num: string; label: string }[] = [];
  if (library.length) tiles.push({ num: String(library.length), label: 'documents kept' });
  if (pagesProcessed) tiles.push({ num: String(pagesProcessed), label: 'pages processed' });
  if (editStats && editStats.pages > 0)
    tiles.push({
      num: String(editStats.pages),
      label: `pages hand-corrected · ${editStats.documents} doc${editStats.documents === 1 ? '' : 's'}`,
    });
  if (cacheStats && cacheStats.entries > 0)
    tiles.push({ num: String(cacheStats.entries), label: `cached runs · ${formatBytes(cacheStats.bytes)}` });
  if (!tiles.length) return null;

  return (
    <section className="stats-strip-wrap">
      <div className="stats-strip">
        {tiles.map((t) => (
          <div className="stat" key={t.label}>
            <div className="stat-num">{t.num}</div>
            <div className="stat-label">{t.label}</div>
          </div>
        ))}
      </div>
      <p className="muted stats-caption">On this machine — reopening is free and never calls the API.</p>
    </section>
  );
}

function LibraryCard({
  meta,
  editedPages,
  open,
  onOpen,
  onDelete,
}: {
  meta: LibraryMeta;
  editedPages: number;
  open: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    // A wrapper div, not a button: the delete control must be a sibling of the open button —
    // a button cannot legally contain another button.
    <div className="lib-card">
      <button
        className="lib-card-open"
        onClick={onOpen}
        title={
          open
            ? 'Already open — switch to it'
            : `Reopen with its saved result — no upload, no API call. Model: ${meta.model}`
        }
      >
        {meta.thumb ? (
          <img className="lib-thumb" src={meta.thumb} alt="" loading="lazy" />
        ) : (
          <span className="lib-thumb placeholder">
            <IconDoc className="lib-thumb-icon" />
          </span>
        )}
        <span className="lib-card-body">
          <span className="lib-card-name">{meta.name}</span>
          <span className="lib-card-meta muted">
            ▤ {meta.pagesProcessed} of {meta.pageCount} · {formatBytes(meta.sizeBytes)} ·{' '}
            {formatWhen(meta.savedAt)}
          </span>
          <span className="lib-card-badges">
            {open ? (
              <span className="chip done">open</span>
            ) : (
              <span className="chip cached">
                <IconZap /> free
              </span>
            )}
            {editedPages > 0 && (
              <span className="chip edited" title={`${editedPages} page${editedPages === 1 ? '' : 's'} hand-corrected`}>
                <IconPen /> {editedPages}
              </span>
            )}
          </span>
        </span>
      </button>
      <button
        className="icon lib-card-del"
        onClick={onDelete}
        aria-label={`Remove ${meta.name} from the library`}
        title="Remove from this list. The scan itself is untouched."
      >
        ✕
      </button>
    </div>
  );
}
