import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Selection, Tab } from '../App';
import { BLOCK_COLORS, linkBlocks, visibleBlocks } from '../lib/ocr';
import { renderMarkdown, renderMarkdownMarked } from '../lib/markdown';
import { buildPageMarks, findSuspects, SUSPECT_LABELS, type MarkKind } from '../lib/suspects';
import { collectRadicands } from '../lib/radicals';
import { applyTableMode, tableToHtml } from '../lib/tables';
import { copy } from '../lib/download';
import { formatWhen } from '../lib/format';
import { renderPageToImage } from '../lib/pdf';
import { reviewSuspects, verifyFigure, visionCompare } from '../lib/vision';
import { applyVisionCorrections } from '../lib/visionCorrections';
import { exportHtml, exportMarkdown, exportPageMarkdown, exportPdf, figureFilename, renderConverted } from '../lib/convert';
import { checkedRedrawPatch, figureCropDataUri, redrawFigureChecked } from '../lib/figure';
import { ConvertTab } from './ConvertTab';
import { EditTab } from './EditTab';
import { effectiveMarkdown, isEdited } from '../lib/editorNodes';
import { docHasEpures, epureFiguresFor } from '../lib/epureCatalog';
import type { Block, DocFile, OcrConfig, OcrPage } from '../lib/types';

// three.js rides along with the viewer (~600 kB) and only one book has épure IRs — nobody else
// should download it. Split it off; it loads when the Épure tab is first opened.
const EpureTab = lazy(() => import('./EpureTab').then((m) => ({ default: m.EpureTab })));

interface Props {
  doc: DocFile;
  /** Every OCR'd page, in order. The pane is one continuous document, like the viewer. */
  pages: OcrPage[];
  page: number;
  config: OcrConfig;
  tab: Tab;
  onTab: (t: Tab) => void;
  onPage: (p: number) => void;
  hovered: Selection | null;
  selected: Selection | null;
  onHover: (s: Selection | null) => void;
  onSelect: (s: Selection | null) => void;
  /** Attach an AI figure redraw to its block (Convert tab). App owns the docs. */
  onRedraw: (pageIndex: number, blockId: string, patch: Partial<Block>) => void;
  /** Persist a page's vision second-opinion onto the page, so it survives navigation and reloads. */
  onVision: (pageIndex: number, patch: Partial<OcrPage>) => void;
  /** Persist a page's human correction (Edit tab). Writes `editedMarkdown` only — never `markdown`. */
  onEdit: (pageIndex: number, patch: Partial<OcrPage>) => void;
  /** File the document's current state (redraws included) in the library. Resolves false if it failed. */
  onSaveProgress: () => Promise<boolean>;
  /** When it was last filed — the Book toolbar says so, so "is my sweep safe?" is answerable. */
  savedAt: number | null;
  /** A restored session's page: scroll there once the sections exist, and hold the spy until then. */
  restorePage?: number | null;
  /** Which épure is open (`EpureFigure.key`). App owns it so Convert can open one from a figure row. */
  epure: string | null;
  onEpure: (key: string) => void;
}

/**
 * How long a restored page is held against a document that is still laying out. Generous, because
 * typesetting a 570-page book takes seconds — but bounded, because a restore must never outlive
 * the reader's own first scroll.
 */
const RESTORE_TRIES = 24;
const RESTORE_INTERVAL_MS = 150;

/**
 * Exported so a restored session can be checked against the tabs that actually exist.
 *
 * `epure` stays in the registry even for documents that have no épure — the list is the set of tab
 * ids that exist, not the set on screen; `docHasEpures` decides that below.
 */
export const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Text result' },
  { id: 'visual', label: 'Visual' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'convert', label: 'Convert' },
  { id: 'book', label: 'Book' },
  { id: 'edit', label: 'Edit' },
  { id: 'epure', label: 'Épure' },
];

export function ResultPane(props: Props) {
  const { doc, pages, page, config, tab } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map());
  /** Set while this pane is scrolling itself, so it doesn't fight the viewer. */
  const selfDriven = useRef(false);
  /**
   * The page a restored session was left on, captured once at mount. Until the jump lands, the
   * scroll-spy below must stay quiet: this pane mounts at the top, so its first observation is
   * "page 1", and reporting that would overwrite the very page we are restoring.
   */
  const restoreTo = useRef<number | null>(props.restorePage ?? null);

  // Scroll-spy: whichever page fills most of this pane becomes the current page, which the
  // viewer then follows. Scrolling either pane moves the other.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !pages.length) return;

    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          ratios.set(Number((e.target as HTMLElement).dataset.pageIndex), e.intersectionRatio);
        }
        // A restore is in flight: whatever is on screen is the top of the document, not where the
        // reader was. Saying so would undo the restore.
        if (restoreTo.current != null) return;
        let best = -1;
        let bestRatio = 0;
        for (const [i, r] of ratios) {
          if (r > bestRatio) {
            bestRatio = r;
            best = i;
          }
        }
        if (best >= 0 && best + 1 !== page) {
          selfDriven.current = true;
          props.onPage(best + 1);
          window.setTimeout(() => (selfDriven.current = false), 400);
        }
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );

    sectionRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, tab, page]);

  // Land on the page a restored session was left on — and STAY there while the document settles.
  //
  // One jump is not enough: this pane types 570 pages of maths, and every KaTeX formula that
  // renders above the target afterwards moves it. Scrolling once lands somewhere near the top and
  // drifts from there. So re-assert the position until the target actually sits at the top of the
  // pane, or the budget runs out. The spy stays quiet throughout (see `restoreTo` above).
  useEffect(() => {
    if (restoreTo.current == null) return;
    let tries = 0;
    const settle = () => {
      const want = restoreTo.current;
      if (want == null) return;
      const target = sectionRefs.current.get(want - 1);
      const root = scrollRef.current;
      if (target && root) {
        const r = target.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        if (Math.abs(r.top - rootRect.top) <= 8) {
          restoreTo.current = null; // landed
          return;
        }
        target.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
      // Give up rather than fight forever: a reader who has started scrolling should not be
      // yanked back by a restore that never converged.
      if (++tries >= RESTORE_TRIES) restoreTo.current = null;
      else window.setTimeout(settle, RESTORE_INTERVAL_MS);
    };
    settle();
  }, [pages, tab]);

  // Follow the viewer. Skipped when this pane caused the change, so the two never tug.
  useEffect(() => {
    if (selfDriven.current) return;
    const target = sectionRefs.current.get(page - 1);
    const root = scrollRef.current;
    if (!target || !root) return;

    const r = target.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (r.top < rootRect.top - 4 || r.top > rootRect.bottom) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [page, tab]);

  const register = useCallback((index: number, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(index, el);
    else sectionRefs.current.delete(index);
  }, []);

  // --- Book view: recreate every figure, and check every figure's labels, across the doc -------
  const recreate = useRecreateAll(doc, pages, config, props.onRedraw, props.onSaveProgress);
  const checkAll = useCheckAllFigures(doc, pages, config, props.onRedraw);

  /** The Edit tab edits the page you are looking at; `page` is 1-based. */
  const editing = useMemo(() => pages.find((p) => p.index === page - 1) ?? pages[0], [pages, page]);

  // The always-on legend explains the underlines; dismissible, and only shown where they appear.
  const [legendOpen, setLegendOpen] = useState(true);
  const hasMarks = useMemo(
    () => tab === 'text' && pages.some((p) => buildPageMarks(p).length > 0),
    [tab, pages],
  );
  // Reads the shipped catalog, not the OCR result: the IR and the plate are both checked in, so
  // the tab is offered (and works) before the document has been run.
  const hasEpures = useMemo(() => docHasEpures(doc), [doc]);
  // pageIndex -> the key of the first épure on that page, so a page that HAS a 3D reconstruction can
  // offer a link straight to it (the "link the pages to the 3D" affordance). Most pages have none.
  const epureByPage = useMemo(() => {
    const m = new Map<number, string>();
    if (hasEpures) for (const f of epureFiguresFor(doc)) if (!m.has(f.pageIndex)) m.set(f.pageIndex, f.key);
    return m;
  }, [doc, hasEpures]);

  return (
    <section className="result" aria-label="OCR result">
      <div className="result-tabs" role="tablist">
        {TABS.map((t) => (
          // The Épure tab is bound to books that have a hand-read épure, which today is one of
          // them; offering it everywhere else would promise a reconstruction that cannot exist.
          (t.id !== 'epure' || hasEpures) && (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => props.onTab(t.id)}
            >
              {t.label}
            </button>
          )
        ))}
        <span className="spacer" />
        {/* Downloads belong on Edit too: correcting a page and then having no way to take it with you
            is the wrong end of the flow. Every export already prefers the corrected text. */}
        {(tab === 'convert' || tab === 'book' || tab === 'edit') && doc.result && (
          <div className="export-toolbar">
            <button className="btn tiny" onClick={() => exportHtml(doc)} title="One self-contained HTML file — typeset math, labelled AI figures">
              ⤓ HTML
            </button>
            <button className="btn tiny" onClick={() => exportMarkdown(doc)} title="One Markdown file — redrawn figures inlined as labelled SVG">
              ⤓ MD
            </button>
            <button className="btn tiny" onClick={() => void exportPdf(doc)} title="Télécharger un vrai fichier PDF">
              ⤓ PDF
            </button>
            {tab === 'edit' && editing && (
              <button
                className="btn tiny primary"
                onClick={() => exportPageMarkdown(doc, editing)}
                title={`Just page ${editing.index + 1} as Markdown — the page you are editing, with your corrections`}
              >
                ⤓ This page
              </button>
            )}
          </div>
        )}
        {doc.result?.documentAnnotation != null && <span className="chip">annotation ✓</span>}
      </div>

      {tab === 'book' && doc.result && (
        <BookToolbar
          recreate={recreate}
          check={checkAll}
          doc={doc}
          onSaveProgress={props.onSaveProgress}
          savedAt={props.savedAt}
        />
      )}

      {tab === 'text' && (
        <SuspectReviewToolbar
          doc={doc}
          pages={pages}
          onVision={props.onVision}
          onEdit={props.onEdit}
        />
      )}

      {hasMarks && legendOpen && <SuspectLegend onClose={() => setLegendOpen(false)} />}

      {doc.result?.warnings.map((w) => (
        <div key={w} className="banner warn">{w}</div>
      ))}

      <div className="result-body" role="tabpanel" ref={scrollRef}>
        {doc.running && (
          <p className="muted pad">
            {doc.progress && doc.progress.total > 1
              ? `Running OCR — chunk ${doc.progress.done + 1} of ${doc.progress.total}…`
              : 'Running OCR…'}
          </p>
        )}
        {doc.error && <p className="error pad">{doc.error}</p>}
        {/* Épure is the one tab that owes nothing to the OCR — the reading and the plate are both
            checked in — so it must not tell the reader to press Run for something already on screen. */}
        {!doc.running && !doc.error && !doc.result && tab !== 'epure' && (
          <p className="muted pad">Press Run (⌘/Ctrl + Enter) to OCR this document.</p>
        )}

        {/* The editor works on ONE page — the current one — rather than the continuous column every
            other tab renders. Editing 570 contenteditable surfaces at once would be absurd, and a
            caret has to live somewhere specific. */}
        {tab === 'edit' ? (
          editing && (
            <EditTab
              doc={doc}
              page={editing}
              blocks={visibleBlocks(editing, config.extractHeader, config.extractFooter)}
              onEdit={props.onEdit}
            />
          )
        ) : tab === 'epure' ? (
          // A workbench for one figure, not a column of pages — and three.js only loads for the
          // one book that has épures, which is why it stays behind a lazy boundary.
          <Suspense fallback={<p className="muted pad">Chargement…</p>}>
            <EpureTab doc={doc} page={page} onPage={props.onPage} selected={props.epure} onSelect={props.onEpure} />
          </Suspense>
        ) : (
          pages.map((p) => (
              <article
                key={p.index}
                className="page-section"
                data-page-index={p.index}
                ref={(el) => register(p.index, el)}
              >
                <div className="page-rule">
                  <span>page {p.index + 1}</span>
                  {epureByPage.has(p.index) && (
                    <button
                      className="btn tiny ghost epure-jump"
                      onClick={() => props.onEpure(epureByPage.get(p.index)!)}
                      title="Reconstruction 3D disponible pour cette figure — l’ouvrir dans l’onglet Épure"
                    >
                      ⬗ Voir en 3D
                    </button>
                  )}
                </div>
                {tab !== 'book' && (
                  <SecondOpinion doc={doc} page={p} onVision={props.onVision} onEdit={props.onEdit} />
                )}
                <PageBody {...props} ocrPage={p} />
              </article>
          ))
        )}
      </div>
    </section>
  );
}

type BodyProps = Props & { ocrPage: OcrPage };

function PageBody(props: BodyProps) {
  const { ocrPage, config, tab } = props;

  const blocks = useMemo(
    () => visibleBlocks(ocrPage, config.extractHeader, config.extractFooter),
    [ocrPage, config.extractHeader, config.extractFooter],
  );

  const images = useMemo(() => {
    const map = new Map<string, string>();
    for (const block of blocks) if (block.imageBase64) map.set(block.text, block.imageBase64);
    return map;
  }, [blocks]);

  // The document's own explicit `\sqrt{…}` vocabulary, used to re-group radicals the OCR bared in
  // table cells. Same set for every page, so it hangs off the result.
  const radicands = useMemo(() => collectRadicands(props.doc.result?.pages ?? []), [props.doc.result]);

  if (tab === 'text') return <TextTab {...props} page={ocrPage} blocks={blocks} images={images} />;
  if (tab === 'visual') return <VisualTab {...props} page={ocrPage} blocks={blocks} />;
  if (tab === 'convert')
    return <ConvertTab doc={props.doc} page={ocrPage} blocks={blocks} onRedraw={props.onRedraw} onEpure={props.onEpure} />;
  if (tab === 'book') return <BookPage page={ocrPage} radicands={radicands} selected={props.selected} />;
  return <MarkdownTab {...props} page={ocrPage} blocks={blocks} />;
}

/** `page` is a number on Props (the current page); inside a tab it's the OcrPage itself. */
type TabProps = Omit<Props, 'page'> & { page: OcrPage; blocks: Block[]; images?: Map<string, string> };

function TextTab({ page, blocks, images, config, hovered, selected, onHover, onSelect }: TabProps) {
  const wantsWords = config.confidence === 'word';

  if (wantsWords && page.words.length) {
    return (
      <div className="prose pad">
        <p className="note">Per-word confidence. Darker means less certain; hover a word for its score.</p>
        <p className="word-stream">
          {page.words.map((w, i) => (
            <span
              key={i}
              className="word"
              title={`${(w.confidence * 100).toFixed(1)}%`}
              style={{ background: confidenceTint(w.confidence) }}
            >
              {w.text}{' '}
            </span>
          ))}
        </p>
      </div>
    );
  }

  // linkBlocks is O(blocks × markdown); memoize it and the suspect scan so the added highlighting
  // never re-runs on an unrelated render (e.g. a hover on the far pane) — matters on a dense book.
  const segments = useMemo(() => linkBlocks(page.markdown, blocks), [page.markdown, blocks]);
  const marks = useMemo(
    () => buildPageMarks(page).map((m, i) => ({ ...m, domId: `sus-${page.index}-${i}` })),
    [page.index, page.markdown, page.visionNotes],
  );

  // Each mark lives at a global offset into page.markdown; the Text tab renders one segment at a
  // time, so clip every mark into the segment it falls in and shift it to that segment's coordinates.
  const rendered = useMemo(() => {
    let gStart = 0;
    return segments.map((seg) => {
      const gEnd = gStart + seg.text.length;
      const local = marks
        .filter((m) => m.start < gEnd && m.end > gStart)
        .map((m) => ({ ...m, start: Math.max(0, m.start - gStart), end: Math.min(seg.text.length, m.end - gStart) }));
      const html = renderMarkdownMarked(seg.text, local, images);
      gStart = gEnd;
      return { blockId: seg.blockId, html };
    });
  }, [segments, marks, images]);

  return (
    <div className="prose pad">
      {marks.length > 0 && <SuspectSummary marks={marks} />}
      {wantsWords && !page.words.length && (
        <p className="note">Word confidence was requested, but this response carried no per-word scores.</p>
      )}
      {config.confidence === 'page' && (
        <p className="note">
          Page confidence:{' '}
          {page.confidence != null ? `${(page.confidence * 100).toFixed(1)}%` : 'not reported for this page.'}
        </p>
      )}
      {rendered.map((segment, i) => (
        <Linked
          key={i}
          blockId={segment.blockId}
          pageIndex={page.index}
          hovered={hovered}
          selected={selected}
          onHover={onHover}
          onSelect={onSelect}
          html={segment.html}
        />
      ))}
    </div>
  );
}

/**
 * A neutral per-page tally of suspect spans — a summary, not a queue: it counts where to look, it
 * does not track or persist a verdict. Free text suspects and the paid vision disagreements are
 * counted separately so a reviewer knows which came for free.
 */
/** What the always-on underlines mean. Dismissible; honest about being hints, not corrections. */
function SuspectLegend({ onClose }: { onClose: () => void }) {
  const items: { kind: MarkKind; label: string }[] = [
    ...(Object.entries(SUSPECT_LABELS) as [MarkKind, string][]).map(([kind, label]) => ({ kind, label })),
    { kind: 'vision', label: 'vision disagreement' },
  ];
  return (
    <div className="suspect-legend">
      {items.map((it) => (
        <span className="lg-item" key={it.kind}>
          <span className={`lg-swatch suspect-${it.kind}`} aria-hidden />
          {it.label}
        </span>
      ))}
      <button className="lg-close" onClick={onClose} title="Hide legend" aria-label="Hide suspect legend">
        ×
      </button>
      <span className="lg-note">
        Signals, not corrections — free hints for where to look. Press <kbd>n</kbd> / <kbd>N</kbd> to step through them.
      </span>
    </div>
  );
}

function SuspectSummary({ marks }: { marks: { kind: MarkKind }[] }) {
  const vision = marks.filter((m) => m.kind === 'vision').length;
  const free = marks.length - vision;
  return (
    <p className="suspect-summary" title="Signals, not corrections — places the transcription looks internally inconsistent. Press n / N to step through them.">
      ⚠ {marks.length} suspect span{marks.length === 1 ? '' : 's'}
      {vision > 0 && <span className="muted"> · {free} text · {vision} vision</span>}
    </p>
  );
}

function VisualTab({ page, blocks, hovered, selected, onHover, onSelect }: TabProps) {
  // Selecting a box on the page scrolls the matching region into view, mirroring the Text tab.
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  useEffect(() => {
    if (selected?.pageIndex === page.index && selected.blockId) {
      itemRefs.current.get(selected.blockId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [selected, page.index]);

  return (
    <div className="visual pad">
      <p className="note">
        {blocks.length} region{blocks.length === 1 ? '' : 's'} detected. Hover one to highlight it on the page.
      </p>
      <ul className="region-list">
        {blocks.map((block) => {
          const isActive = hovered?.blockId === block.id || selected?.blockId === block.id;
          return (
            <li
              key={block.id}
              ref={(el) => {
                if (el) itemRefs.current.set(block.id, el);
                else itemRefs.current.delete(block.id);
              }}
              className={`region${isActive ? ' active' : ''}`}
              style={{ borderLeftColor: BLOCK_COLORS[block.type] }}
              onMouseEnter={() => onHover({ pageIndex: page.index, blockId: block.id })}
              onMouseLeave={() => onHover(null)}
              onClick={() =>
                onSelect(selected?.blockId === block.id ? null : { pageIndex: page.index, blockId: block.id })
              }
            >
              <div className="region-head">
                <span className="box-tag static" style={{ background: BLOCK_COLORS[block.type] }}>{block.type}</span>
                <code className="muted">
                  {Math.round(block.bbox.x)}, {Math.round(block.bbox.y)} · {Math.round(block.bbox.w)}×
                  {Math.round(block.bbox.h)}
                </code>
                {block.confidence != null && <span className="chip">{(block.confidence * 100).toFixed(0)}%</span>}
                <button className="btn tiny" onClick={(e) => { e.stopPropagation(); void copy(block.text); }}>
                  Copy
                </button>
              </div>
              {block.imageBase64 ? (
                <img className="region-thumb" src={asDataUri(block.imageBase64)} alt={block.text} />
              ) : (
                <p className="region-text">{block.text || <em className="muted">no text returned</em>}</p>
              )}
              {block.annotation != null && (
                <pre className="annotation">{JSON.stringify(block.annotation, null, 2)}</pre>
              )}
            </li>
          );
        })}
        {!blocks.length && (
          <p className="muted">No regions. Turn on “Extract bounding boxes” in Configure and run again.</p>
        )}
      </ul>
    </div>
  );
}

function MarkdownTab({ page, blocks, config, hovered, selected, onHover, onSelect }: TabProps) {
  // The raw view is what you copy/export, so it shows the corrected text once the page has been
  // edited. (The Text tab deliberately stays on the OCR original — that's the inspection view.)
  const source = effectiveMarkdown(page);
  const { body, tables } = applyTableMode(source, config.tableMode);
  const segments = linkBlocks(body, blocks);

  // Selecting a box on the page scrolls the matching markdown block into view, like the Text tab.
  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (selected?.pageIndex === page.index && selected.blockId) {
      blockRefs.current.get(selected.blockId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [selected, page.index]);

  return (
    <div className="markdown-tab pad">
      <div className="md-actions">
        <button className="btn tiny" onClick={() => void copy(source)}>Copy page markdown</button>
        {isEdited(page) && <span className="chip edited" title="This page has been edited; the OCR original is kept underneath.">✎ edited</span>}
      </div>

      {segments.filter((s) => s.text.trim()).map((segment, i) => (
        <div
          key={i}
          ref={(el) => {
            if (!segment.blockId) return;
            if (el) blockRefs.current.set(segment.blockId, el);
            else blockRefs.current.delete(segment.blockId);
          }}
          className={`md-block${isActive(segment.blockId, hovered, selected) ? ' active' : ''}`}
          data-block-id={segment.blockId ?? undefined}
          onMouseEnter={() => segment.blockId && onHover({ pageIndex: page.index, blockId: segment.blockId })}
          onMouseLeave={() => onHover(null)}
          onClick={() =>
            segment.blockId &&
            onSelect(
              selected?.blockId === segment.blockId ? null : { pageIndex: page.index, blockId: segment.blockId },
            )
          }
        >
          <button className="btn tiny copy" onClick={(e) => { e.stopPropagation(); void copy(segment.text); }}>
            Copy
          </button>
          <pre>{segment.text.trim()}</pre>
        </div>
      ))}

      {tables.map((table, i) => (
        <div key={`t${i}`} className="md-block standalone">
          <button
            className="btn tiny copy"
            onClick={() => void copy(config.tableMode === 'html_standalone' ? table.html : table.markdown)}
          >
            Copy
          </button>
          <h4>Table {i + 1}</h4>
          <pre>{config.tableMode === 'html_standalone' ? table.html : table.markdown}</pre>
          <div className="table-preview" dangerouslySetInnerHTML={{ __html: tableToHtml(table.markdown) }} />
        </div>
      ))}
    </div>
  );
}

function Linked(props: {
  blockId: string | null;
  pageIndex: number;
  html: string;
  hovered: Selection | null;
  selected: Selection | null;
  onHover: (s: Selection | null) => void;
  onSelect: (s: Selection | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = isActive(props.blockId, props.hovered, props.selected);

  // Selecting a box on the page scrolls the matching prose into view.
  useEffect(() => {
    if (props.blockId && props.selected?.blockId === props.blockId) {
      ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [props.selected, props.blockId]);

  return (
    <div
      ref={ref}
      className={`seg${props.blockId ? ' linkable' : ''}${active ? ' active' : ''}`}
      onMouseEnter={() =>
        props.blockId && props.onHover({ pageIndex: props.pageIndex, blockId: props.blockId })
      }
      onMouseLeave={() => props.blockId && props.onHover(null)}
      onClick={() =>
        props.blockId &&
        props.onSelect(
          props.selected?.blockId === props.blockId
            ? null
            : { pageIndex: props.pageIndex, blockId: props.blockId },
        )
      }
      dangerouslySetInnerHTML={{ __html: props.html }}
    />
  );
}

async function improveSuspectPage(
  doc: DocFile,
  page: OcrPage,
  onVision: (pageIndex: number, patch: Partial<OcrPage>) => void,
  onEdit: (pageIndex: number, patch: Partial<OcrPage>) => void,
) {
  const spans = findSuspects(page.markdown);
  if (!spans.length) return { suspects: 0, applied: 0, suggestions: 0 };
  const image = doc.sourceType === 'image_url'
    ? doc.dataUri
    : await renderPageToImage(doc.id, doc.dataUri, page.index, 2200, 0.92);
  const result = await reviewSuspects(image, page.markdown, spans.map((s) => ({
    start: s.start,
    end: s.end,
    text: page.markdown.slice(s.start, s.end),
    kind: s.kind,
    context: page.markdown.slice(Math.max(0, s.start - 120), Math.min(page.markdown.length, s.end + 120)),
  })));
  if (result.raw) throw new Error('GPT-5.6 returned an unreadable review. Please retry this page.');

  const current = effectiveMarkdown(page);
  const applied = applyVisionCorrections(current, page.markdown, result.corrections);
  onVision(page.index, {
    visionModel: result.model,
    visionCorrections: applied.corrections,
    visionCorrectedAt: Date.now(),
  });
  const appliedCount = applied.corrections.filter((c) => c.applied).length;
  if (appliedCount && applied.markdown !== current) onEdit(page.index, { editedMarkdown: applied.markdown });
  return {
    suspects: spans.length,
    applied: appliedCount,
    suggestions: applied.corrections.length - appliedCount,
  };
}

function SuspectReviewToolbar({
  doc,
  pages,
  onVision,
  onEdit,
}: {
  doc: DocFile;
  pages: OcrPage[];
  onVision: (pageIndex: number, patch: Partial<OcrPage>) => void;
  onEdit: (pageIndex: number, patch: Partial<OcrPage>) => void;
}) {
  const candidates = useMemo(
    () => pages.filter((p) => !p.visionCorrectedAt && findSuspects(p.markdown).length > 0),
    [pages],
  );
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; applied: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAll = async () => {
    setRunning(true);
    setError(null);
    let applied = 0;
    setProgress({ done: 0, total: candidates.length, applied: 0 });
    try {
      for (let i = 0; i < candidates.length; i++) {
        const result = await improveSuspectPage(doc, candidates[i], onVision, onEdit);
        applied += result.applied;
        setProgress({ done: i + 1, total: candidates.length, applied });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (!candidates.length && !progress) return null;
  return (
    <div className="suspect-review-toolbar">
      <div>
        <strong>GPT‑5.6 Vision review</strong>
        <span>Checks only suspect spans against their source scans; original OCR is preserved.</span>
      </div>
      <button className="btn tiny primary" onClick={() => void runAll()} disabled={running || !candidates.length}>
        {running && progress
          ? `Reviewing ${Math.min(progress.done + 1, progress.total)}/${progress.total}…`
          : candidates.length
            ? `Improve ${candidates.length} suspect page${candidates.length === 1 ? '' : 's'}`
            : 'Review complete'}
      </button>
      {progress && !running && <span className="chip done">{progress.applied} correction{progress.applied === 1 ? '' : 's'} applied</span>}
      {error && <p className="vision-err">Review stopped: {error}</p>}
    </div>
  );
}

/**
 * On-demand "second reading" of one page. A vision model reads the page image and reports only
 * where it disagrees with the OCR text — surfacing the silent edits (invented accents) that text
 * alone cannot expose. Deliberately an inspection aid: it points at where to look and certifies
 * nothing. No flags, no queue, no `verified` — those belong to Review, not to this inspector.
 */
function SecondOpinion({
  doc,
  page,
  onVision,
  onEdit,
}: {
  doc: DocFile;
  page: OcrPage;
  onVision: (pageIndex: number, patch: Partial<OcrPage>) => void;
  onEdit: (pageIndex: number, patch: Partial<OcrPage>) => void;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const [improving, setImproving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setState('running');
    setErr(null);
    try {
      const image =
        doc.sourceType === 'image_url'
          ? doc.dataUri
          : await renderPageToImage(doc.id, doc.dataUri, page.index);
      const result = await visionCompare(image, page.markdown);
      // Persist onto the page (not local state) so the paid reading survives navigation/reload and
      // its disagreements can be highlighted in place. A soft failure (raw, no parsed notes) is not
      // recorded as "checked", so it stays retryable — mirroring the figure routes' rule.
      onVision(page.index, {
        visionNotes: result.notes,
        visionModel: result.model,
        visionChecked: !result.raw,
      });
      if (result.raw) setErr('The vision model returned an unparseable response — try again.');
      setState('idle');
    } catch (e) {
      setErr((e as Error).message);
      setState('error');
    }
  };

  const improve = async () => {
    setImproving(true);
    setErr(null);
    try {
      await improveSuspectPage(doc, page, onVision, onEdit);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setImproving(false);
    }
  };

  const checked = page.visionChecked;
  const notes = page.visionNotes ?? [];
  const clean = checked && notes.length === 0;
  const suspects = findSuspects(page.markdown);
  const corrections = page.visionCorrections ?? [];

  return (
    <div className="second-opinion">
      <button className="btn tiny ghost" onClick={run} disabled={state === 'running'}>
        {state === 'running' ? 'Reading the page…' : checked ? '↻ Second opinion' : '⧉ Second opinion'}
      </button>
      {suspects.length > 0 && (
        <button className="btn tiny vision-improve" onClick={() => void improve()} disabled={improving}>
          {improving ? 'GPT‑5.6 is checking…' : `✦ Improve ${suspects.length} suspect span${suspects.length === 1 ? '' : 's'}`}
        </button>
      )}

      {err && <p className="vision-err">Vision review: {err}</p>}

      {checked && (
        <div className={`vision-panel${clean ? ' ok' : ''}`}>
          {clean ? (
            <p className="vision-ok">A second, independent vision reading agrees with this transcription.</p>
          ) : (
            <>
              <p className="vision-head">
                The vision reading disagrees with the OCR in {notes.length}{' '}
                place{notes.length === 1 ? '' : 's'} — underlined in the text above where locatable:
              </p>
              <ul className="vision-notes">
                {notes.map((n, i) => (
                  <li key={i}>
                    <span className="vk">{n.kind}</span>
                    <span className="vo">OCR: <code>{n.ocr}</code></span>
                    <span className="vi">page: <code>{n.image}</code></span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="vision-foot">
            Independent reading by <code>{page.visionModel}</code>. This is an inspection, not a verified
            correction — the raw text remains the evidence.
          </p>
        </div>
      )}
      {corrections.length > 0 && (
        <div className="vision-corrections">
          <p><strong>GPT‑5.6 visual corrections</strong> · {corrections.filter((c) => c.applied).length} applied</p>
          <ul>
            {corrections.map((c, i) => (
              <li key={`${c.start}-${i}`} className={c.applied ? 'applied' : 'suggested'}>
                <span>{c.applied ? 'Applied' : 'Review'}</span>
                <code>{c.ocr}</code> → <code>{c.replacement}</code>
                <small>{c.reason}{c.confidence === 'medium' ? ' · medium confidence' : ''}</small>
              </li>
            ))}
          </ul>
          <p className="vision-foot">The OCR evidence is unchanged. Applied text is stored in the editable layer used by Book and exports.</p>
        </div>
      )}
    </div>
  );
}

/**
 * One page of the Book view — the whole document read as one continuous serif column. Same
 * converted rendering as the Convert tab, but figures are shown inline as their AI recreation
 * ALONE (no side-by-side scan): the point here is reading, not comparing. Recreations live on the
 * block, so a page re-renders the instant "Recreate all figures" fills one in.
 */
function BookPage({ page, radicands, selected }: { page: OcrPage; radicands: ReadonlySet<string>; selected: Selection | null }) {
  const html = useMemo(() => renderConverted(page, { compare: false, radicands }), [page, radicands]);
  const selectedBlock = selected?.pageIndex === page.index
    ? page.blocks.find((block) => block.id === selected.blockId) ?? null
    : null;
  const selectionRef = useRef<HTMLDivElement>(null);
  const selectedCrop = useMemo(() => {
    if (!selectedBlock || selectedBlock.type !== 'image') return null;
    const filename = figureFilename(selectedBlock);
    const alias = page.blocks.find((block) =>
      block.type === 'image' && block.imageBase64 && (
        figureFilename(block) === filename ||
        (block.bbox.x === selectedBlock.bbox.x && block.bbox.y === selectedBlock.bbox.y &&
          block.bbox.w === selectedBlock.bbox.w && block.bbox.h === selectedBlock.bbox.h)
      ));
    return alias?.imageBase64 ?? selectedBlock.imageBase64 ?? null;
  }, [page.blocks, selectedBlock]);

  useEffect(() => {
    if (!selectedBlock) return;
    selectionRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedBlock]);

  return (
    <>
      {selectedBlock && (
        <div ref={selectionRef} className="book-source-selection" aria-live="polite">
          <div className="book-source-selection-head">
            <strong>Sélection exacte sur le scan</strong>
            <span>page {page.index + 1} · {selectedBlock.type} · {selectedBlock.id}</span>
          </div>
          {selectedCrop ? (
            <img src={selectedCrop.startsWith('data:') ? selectedCrop : `data:image/jpeg;base64,${selectedCrop}`} alt="Région sélectionnée sur le scan" />
          ) : (
            // eslint-disable-next-line react/no-danger -- OCR text rendered by the same sanitized Markdown renderer
            <div className="book-source-selection-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedBlock.text, new Map()) }} />
          )}
          <p>Ce panneau reprend uniquement le bloc sélectionné à gauche. Le livre converti continue ci-dessous.</p>
        </div>
      )}
      {/* eslint-disable-next-line react/no-danger -- output of our own renderer + sanitized SVG */}
      <div className="book convert-doc pad" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

/**
 * One deduped figure block per figure across the whole document (Mistral reports each figure
 * twice — extracted image + bbox block). Shared by the recreate-all and check-all passes so both
 * walk exactly the same set the Convert tab shows.
 */
function collectFigures(pages: OcrPage[], keepHeader: boolean, keepFooter: boolean): { page: OcrPage; block: Block }[] {
  const out: { page: OcrPage; block: Block }[] = [];
  for (const page of pages) {
    const blocks = visibleBlocks(page, keepHeader, keepFooter);
    const byFile = new Map<string, Block>();
    const score = (b: Block) =>
      (b.redrawnSvg && !b.redrawnStub ? 3 : 0) + (b.redrawNotChart ? 2 : 0) + (b.imageBase64 ? 1 : 0);
    for (const b of blocks) {
      if (b.type !== 'image') continue;
      const file = figureFilename(b);
      const cur = byFile.get(file);
      if (!cur || score(b) > score(cur)) byFile.set(file, b);
    }
    for (const block of byFile.values()) out.push({ page, block });
  }
  return out;
}

/**
 * Recreate every figure in the whole document in one pass, for the Book view. A figure is RESOLVED
 * once it carries a real (non-stub) redraw OR was judged not-a-chart (scan kept) — a non-chart is a
 * valid final answer, not a pending item, so the pass doesn't retry it forever or count it as a
 * failure. The run is sequential — each figure is a large upload to a paid model — writing every
 * result straight to its block, so progress is durable and the whole thing is resumable.
 */
function useRecreateAll(
  doc: DocFile,
  pages: OcrPage[],
  config: OcrConfig,
  onRedraw: (pageIndex: number, blockId: string, patch: Partial<Block>) => void,
  onSaveProgress: () => Promise<boolean>,
) {
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [running, setRunning] = useState(false);
  const cancel = useRef(false);

  const figures = useMemo(
    () => collectFigures(pages, config.extractHeader, config.extractFooter),
    [pages, config.extractHeader, config.extractFooter],
  );

  // The purpose of this view is to AI-redraw every figure, so a figure is DONE only once it carries a
  // real (non-stub) redraw. A "kept scan" (from the old gate, or a blank crop) counts as pending — the
  // sweep redraws it too. The prompt reproduces faithfully, so redrawing an apparatus draws the
  // apparatus, not an invented chart.
  // A hand-authored figure (or a canonical reference) is FINAL: the paid AI sweep must never spend
  // money overwriting a drawing a human already checked against the scan.
  const resolved = ({ block }: { block: Block }) =>
    block.redrawnAuthored || block.redrawnCanonical || (Boolean(block.redrawnSvg) && !block.redrawnStub);
  const recreated = figures.filter(resolved).length;
  const pending = figures.length - recreated;
  const mismatched = figures.filter(({ block }) => block.redrawProblems && block.redrawProblems.length).length;

  const run = useCallback(
    async (todo: { page: OcrPage; block: Block }[], force: boolean) => {
      if (running || !todo.length) return;
      cancel.current = false;
      setRunning(true);
      setProgress({ done: 0, total: todo.length, failed: 0 });
      let processed = 0;
      let failed = 0;
      for (const { page, block } of todo) {
        if (cancel.current) break;
        try {
          const image = await figureCropDataUri(doc, page, block);
          const r = await redrawFigureChecked(image, page.markdown.slice(0, 2500), { force });
          onRedraw(page.index, block.id, checkedRedrawPatch(r));
          // Only a blank crop (isChart:false) or a missing SVG leaves nothing drawn.
          if (!r.redraw.svg) failed++;
        } catch {
          failed++;
        }
        processed++;
        setProgress({ done: processed, total: todo.length, failed });
      }
      setRunning(false);
      // File the sweep the moment it ends — including when it was stopped or partly failed. Hours
      // of paid redraws live in the session until this runs; a Restart or a lost tab before it
      // would take them with it.
      await onSaveProgress();
      // A clean finish resets the toolbar; leave the bar up if something needs attention.
      if (!failed && !cancel.current) setProgress(null);
    },
    [doc, onRedraw, onSaveProgress, running],
  );

  const start = useCallback(() => run(figures.filter((f) => !resolved(f)), false), [figures, run]);

  // The force re-sweep: redraw figures that ALREADY have a real redraw, deliberately bypassing the
  // cache — the only way to get a better version of a bad drawing. Authored and canonical stay
  // untouchable (human work is final); not-chart verdicts are excluded because they are already
  // pending for the normal sweep — including them here would pay twice for the same blanks.
  const redoTargets = useCallback(
    () =>
      figures.filter(
        ({ block }) =>
          Boolean(block.redrawnSvg) && !block.redrawnStub && !block.redrawnAuthored && !block.redrawnCanonical,
      ),
    [figures],
  );
  const startAgain = useCallback(() => run(redoTargets(), true), [redoTargets, run]);
  const redoable = redoTargets().length;

  const stop = useCallback(() => {
    cancel.current = true;
    setRunning(false);
  }, []);

  return {
    figuresTotal: figures.length,
    recreated,
    pending,
    mismatched,
    redoable,
    progress,
    running,
    start,
    startAgain,
    stop,
  };
}

/**
 * Check every figure's labels across the whole document in one pass — the investigator, run as a
 * batch. Each figure gets an independent vision reading whose disagreements with the OCR are
 * written to the block as flags (never edits). Sequential and resumable exactly like recreate:
 * a figure is "done" once it has been checked, so a re-run only pays for the ones still unchecked.
 */
function useCheckAllFigures(
  doc: DocFile,
  pages: OcrPage[],
  config: OcrConfig,
  onRedraw: (pageIndex: number, blockId: string, patch: Partial<Block>) => void,
) {
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [running, setRunning] = useState(false);
  const cancel = useRef(false);

  const figures = useMemo(
    () => collectFigures(pages, config.extractHeader, config.extractFooter),
    [pages, config.extractHeader, config.extractFooter],
  );

  const checked = figures.filter(({ block }) => block.labelChecked).length;
  const flagged = figures.filter(({ block }) => block.labelNotes && block.labelNotes.length).length;
  const pending = figures.length - checked;

  const start = useCallback(async () => {
    if (running) return;
    const todo = figures.filter(({ block }) => !block.labelChecked);
    if (!todo.length) return;
    cancel.current = false;
    setRunning(true);
    setProgress({ done: 0, total: todo.length, failed: 0 });
    let processed = 0;
    let failed = 0;
    for (const { page, block } of todo) {
      if (cancel.current) break;
      try {
        const image = await figureCropDataUri(doc, page, block);
        const r = await verifyFigure(image, page.markdown.slice(0, 2500));
        onRedraw(page.index, block.id, { labelNotes: r.notes, labelCheckModel: r.model, labelChecked: true });
      } catch {
        failed++;
      }
      processed++;
      setProgress({ done: processed, total: todo.length, failed });
    }
    setRunning(false);
    if (!failed && !cancel.current) setProgress(null);
  }, [doc, figures, onRedraw, running]);

  const stop = useCallback(() => {
    cancel.current = true;
    setRunning(false);
  }, []);

  return { figuresTotal: figures.length, checked, flagged, pending, progress, running, start, stop };
}

/** The Book view's recreate-all control strip: counts, the run/stop button, a progress bar. */
function BookToolbar({
  recreate,
  check,
  doc,
  onSaveProgress,
  savedAt,
}: {
  recreate: ReturnType<typeof useRecreateAll>;
  check: ReturnType<typeof useCheckAllFigures>;
  doc: DocFile;
  onSaveProgress: () => Promise<boolean>;
  savedAt: number | null;
}) {
  const { figuresTotal, recreated, pending, mismatched, redoable, progress, running, start, startAgain, stop } =
    recreate;
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await onSaveProgress();
    } finally {
      setSaving(false);
    }
  };

  if (figuresTotal === 0) {
    return (
      <div className="book-toolbar">
        <span className="muted">No figures detected in this document — the text below is the whole book.</span>
        <button className="btn tiny primary" onClick={() => exportHtml(doc)} title="One self-contained HTML file — the whole book, typeset.">
          ⤓ Save the book (HTML)
        </button>
      </div>
    );
  }

  return (
    <div className="book-toolbar">
      {/* Recreate: AI-redraw EVERY figure faithfully — the purpose of this view. */}
      <div className="book-toolbar-row">
        <span className="book-count">
          {figuresTotal} figure{figuresTotal === 1 ? '' : 's'} · {recreated} recreated
          {pending > 0 && (
            <>
              {' · '}
              <strong>{pending} pending</strong>
            </>
          )}
          {mismatched > 0 && (
            <>
              {' · '}
              <strong>{mismatched} with mismatch notes</strong>
            </>
          )}
        </span>
        {running ? (
          <button className="btn tiny" onClick={stop}>■ Stop</button>
        ) : (
          <>
            <button className="btn tiny primary" onClick={() => void start()} disabled={pending === 0}>
              {pending === 0 ? '✓ All figures recreated' : `✦ Recreate all figures (${pending})`}
            </button>
            <button
              className="btn tiny"
              onClick={() => void startAgain()}
              disabled={redoable === 0}
              title="Re-draw every figure that already has an AI redraw, deliberately bypassing the cache. Billed: up to ~3 vision calls per figure."
            >
              ↻ Redraw all again ({redoable})
            </button>
          </>
        )}
      </div>

      {progress && (
        <div className="book-progress">
          <div className="book-progress-bar">
            <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <span className="muted">
            {running
              ? `Recreating & checking ${progress.done} / ${progress.total}…`
              : `Stopped at ${progress.done} / ${progress.total}.`}
            {progress.failed > 0 && ` ${progress.failed} had nothing to draw (blank crop).`}
          </span>
        </div>
      )}

      {/* Investigate: read each figure's labels and flag where the OCR disagrees (e.g. 0^{-3} ↔ 10^{-3}). */}
      <div className="book-toolbar-row">
        <span className="book-count">
          {check.checked} checked
          {check.flagged > 0 && (
            <>
              {' · '}
              <strong>{check.flagged} with flags</strong>
            </>
          )}
        </span>
        {check.running ? (
          <button className="btn tiny" onClick={check.stop}>■ Stop</button>
        ) : (
          <button className="btn tiny" onClick={() => void check.start()} disabled={check.pending === 0}>
            {check.pending === 0 ? '✓ All labels checked' : `⧉ Check all figure labels (${check.pending})`}
          </button>
        )}
      </div>

      {check.progress && (
        <div className="book-progress">
          <div className="book-progress-bar">
            <span style={{ width: `${check.progress.total ? (check.progress.done / check.progress.total) * 100 : 0}%` }} />
          </div>
          <span className="muted">
            {check.running
              ? `Checking labels ${check.progress.done} / ${check.progress.total}…`
              : `Stopped at ${check.progress.done} / ${check.progress.total}.`}
            {check.progress.failed > 0 && ` ${check.progress.failed} could not be checked.`}
          </span>
        </div>
      )}

      {/* Save: the recreated book is the artifact this view exists to produce, and the figures in it
          are the expensive part. The two halves of "saved" are different things and both belong
          here — the library copy survives Restart and a new session; the exported file survives this
          browser entirely. */}
      <div className="book-toolbar-row">
        <span className="book-count">
          {savedAt ? (
            <>
              ✓ progress filed in your library <span className="muted">· {formatWhen(savedAt)}</span>
            </>
          ) : (
            <span className="muted">Progress is kept in this browser — save the book for a copy that outlives it.</span>
          )}
        </span>
        <button
          className="btn tiny primary"
          onClick={() => exportHtml(doc)}
          title="One self-contained HTML file: the whole book, typeset, with every recreated figure inlined. Independent of this browser's storage."
        >
          ⤓ Save the book (HTML)
        </button>
        <button
          className="btn tiny"
          onClick={() => void save()}
          disabled={saving}
          title="File this document's current state — every redraw, check and correction — in your library, so it survives Restart and reopens for free."
        >
          {saving ? 'Saving…' : '⛁ Save progress'}
        </button>
      </div>

      {(pending > 0 || check.pending > 0 || redoable > 0) && !running && !check.running && (
        <p className="book-note muted">
          Recreating a figure now runs a checked loop: redraw, a critic compares it against the scan, and one
          automatic retry when they disagree — up to ~3 paid vision calls per figure (~1–2 min each). Results are
          cached and stored on the figure, and filed in your library when a sweep ends, so the pass is resumable.
          « Redraw all again » deliberately bypasses the cache and re-bills every figure it touches. Mismatches
          the critic still sees stay printed under the figure — they flag where to look, they never edit anything.
        </p>
      )}
    </div>
  );
}

function isActive(blockId: string | null, hovered: Selection | null, selected: Selection | null): boolean {
  return blockId != null && (hovered?.blockId === blockId || selected?.blockId === blockId);
}

/** Low confidence reads hot; high confidence fades out. */
function confidenceTint(confidence: number): string {
  const alpha = Math.max(0, Math.min(0.55, (1 - confidence) * 1.6));
  return `rgba(234, 88, 12, ${alpha.toFixed(3)})`;
}

function asDataUri(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
}
