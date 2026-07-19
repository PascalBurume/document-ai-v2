import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { Selection } from '../App';
import { loadPdf } from '../lib/pdf';
import { BLOCK_COLORS, visibleBlocks } from '../lib/ocr';
import type { DocFile, OcrPage } from '../lib/types';

/** Breathing room around the page, in px. Also what the fit-to-width measurement subtracts. */
const PAGE_MARGIN = 24;

/** Render this many pages beyond the viewport; release canvases past it. A 266-page scan
 *  must not mean 266 live bitmaps. */
const RENDER_AHEAD = 2;

interface Props {
  doc: DocFile;
  /** Every OCR'd page, keyed by its index in the document. A page range means gaps. */
  ocrPages: OcrPage[];
  page: number;
  pageCount: number;
  zoom: number;
  fitWidth: boolean;
  showBoxes: boolean;
  keepHeader: boolean;
  keepFooter: boolean;
  hovered: Selection | null;
  selected: Selection | null;
  onHover: (s: Selection | null) => void;
  onSelect: (s: Selection | null) => void;
  onPage: (p: number) => void;
  onZoom: (z: number) => void;
  onFitWidth: () => void;
  /** A restored session's page: jump there once the page slots exist, and don't report a page
   *  until we have (this pane mounts at the top, and the spy would say "page 1" straight away). */
  restorePage?: number | null;
}

interface PageDims {
  width: number;
  height: number;
}

/** See the matching note in ResultPane: a restored page is held while the document lays out. */
const RESTORE_TRIES = 24;
const RESTORE_INTERVAL_MS = 150;

export function Viewer(props: Props) {
  const { doc, ocrPages, page, pageCount, zoom, fitWidth, showBoxes } = props;

  const paneRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** True while we are scrolling *to* a page, so scroll-spy doesn't fight the jump. */
  const scrollingTo = useRef(false);
  // Raised by the scroll-spy just before it reports a new page, so the follow-effect can tell "the
  // reader scrolled here" (leave it alone) from "the page was set externally" (bring it to the top).
  const spyDriven = useRef(false);
  /**
   * The page a restored session was left on, captured once at mount. Held until the page slots
   * are laid out (which needs every page's size, so it is not available on the first frame) and
   * then jumped to. `scrollingTo` is raised immediately so the spy — which would otherwise report
   * page 1 from the top of an unscrolled pane — cannot overwrite the restored page first.
   */
  const restoreTo = useRef<number | null>(props.restorePage ?? null);
  if (restoreTo.current != null) scrollingTo.current = true;

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [dims, setDims] = useState<PageDims[]>([]);
  const [available, setAvailable] = useState(800);
  const [visible, setVisible] = useState<Set<number>>(new Set([0]));
  const [pageInput, setPageInput] = useState('1');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPageInput(String(page)), [page]);

  // Measure the pane, NOT the scroller: observing the scrolling element makes the canvas
  // fight its own scrollbar (wider canvas -> scrollbar appears -> less width -> narrower
  // canvas -> scrollbar goes -> repeat). That oscillation is what "vibrating" looked like.
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(200, Math.round(entry.contentRect.width) - PAGE_MARGIN * 2);
      setAvailable((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Load the document and every page's intrinsic size once. The sizes let us lay out all
  // 100 page slots at the right height immediately, so the scrollbar is honest from the
  // first frame and never jumps as pages paint in.
  useEffect(() => {
    if (doc.sourceType !== 'document_url') return;
    let cancelled = false;

    (async () => {
      try {
        const loaded = await loadPdf(doc.id, doc.dataUri);
        if (cancelled) return;

        const sizes = await Promise.all(
          Array.from({ length: loaded.numPages }, async (_, i) => {
            const p = await loaded.getPage(i + 1);
            const v = p.getViewport({ scale: 1 });
            return { width: v.width, height: v.height };
          }),
        );
        if (cancelled) return;

        setPdf(loaded);
        setDims(sizes);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc.id, doc.dataUri, doc.sourceType]);

  /** One scale for the whole document, from the widest page so nothing overflows. */
  const scale = useMemo(() => {
    if (!fitWidth) return zoom;
    const widest = dims.reduce((max, d) => Math.max(max, d.width), 0);
    if (!widest) return 1;
    // Quantised so a sub-pixel layout wobble can't trigger a fresh render of every page.
    return Math.round((available / widest) * 100) / 100;
  }, [fitWidth, zoom, dims, available]);

  // Scroll-spy: the page filling most of the viewport is the current page. This is what
  // replaces the next/prev button as the source of truth.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !dims.length) return;

    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.pageIndex);
          ratios.set(i, e.intersectionRatio);
        }

        // Keep a margin of rendered pages around whatever is on screen.
        const onScreen = [...ratios.entries()].filter(([, r]) => r > 0).map(([i]) => i);
        if (onScreen.length) {
          const lo = Math.max(0, Math.min(...onScreen) - RENDER_AHEAD);
          const hi = Math.min(dims.length - 1, Math.max(...onScreen) + RENDER_AHEAD);
          setVisible(new Set(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)));
        }

        if (scrollingTo.current) return;
        let best = -1;
        let bestRatio = 0;
        for (const [i, r] of ratios) {
          if (r > bestRatio) {
            bestRatio = r;
            best = i;
          }
        }
        if (best >= 0 && best + 1 !== page) {
          spyDriven.current = true; // this change came from scrolling — the follow-effect must not re-scroll
          props.onPage(best + 1);
        }
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );

    pageRefs.current.slice(0, dims.length).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
    // props.onPage and page are read fresh via closure on each callback fire; re-subscribing
    // on every page change would thrash the observer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims.length, page]);

  /** Next/prev/jump now scroll rather than swap the page out. */
  const goToPage = useCallback((n: number) => {
    const target = pageRefs.current[n - 1];
    if (!target) return;
    scrollingTo.current = true;
    props.onPage(n);
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    window.setTimeout(() => {
      scrollingTo.current = false;
    }, 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Land on the page a restored session was left on, once the slots to land on exist — and stay
  // there while they settle. Instant, not smooth: this is where the document already was, not a
  // journey the reader took. Held like the result pane's (see the note there): page canvases paint
  // in after the jump, and each one that lands above the target moves it.
  useEffect(() => {
    if (restoreTo.current == null || !dims.length) return;
    let tries = 0;
    const settle = () => {
      const want = restoreTo.current;
      if (want == null) return;
      const target = pageRefs.current[want - 1];
      const root = scrollRef.current;
      if (target && root) {
        const r = target.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        if (Math.abs(r.top - rootRect.top) <= 8) {
          restoreTo.current = null;
          scrollingTo.current = false; // let the spy speak again, from where we landed
          return;
        }
        target.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
      if (++tries >= RESTORE_TRIES) {
        restoreTo.current = null;
        scrollingTo.current = false;
      } else {
        window.setTimeout(settle, RESTORE_INTERVAL_MS);
      }
    };
    settle();
  }, [dims.length]);

  // The parent drives the page from outside the viewer too: ←/→ keys, the épure figure stepper, the
  // page-linked index. Follow those — but not the spy's own reports, which would fight a manual drag.
  const lastPage = useRef(page);
  useEffect(() => {
    if (page === lastPage.current) return;
    lastPage.current = page;
    // The spy just told us where the reader scrolled — do not scroll again on top of them.
    if (spyDriven.current) {
      spyDriven.current = false;
      return;
    }
    if (scrollingTo.current) return;
    const target = pageRefs.current[page - 1];
    const root = scrollRef.current;
    if (!target || !root) return;
    // Bring the page to the top whenever it isn't already there — including an ADJACENT page that is
    // merely partly visible. The old "only if off-screen" test made stepping to a neighbouring figure
    // a no-op, and the spy then reverted the change.
    const r = target.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (Math.abs(r.top - rootRect.top) > 4) {
      scrollingTo.current = true;
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      window.setTimeout(() => {
        scrollingTo.current = false;
      }, 600);
    }
  }, [page]);

  const byIndex = useMemo(() => new Map(ocrPages.map((p) => [p.index, p])), [ocrPages]);

  const commitPage = () => {
    const n = Number(pageInput);
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) goToPage(n);
    else setPageInput(String(page));
  };

  return (
    <section className="viewer" aria-label="Document preview" ref={paneRef}>
      <div className="viewer-toolbar">
        <div className="tool-group">
          <button className="icon" onClick={() => goToPage(Math.max(1, page - 1))} disabled={page <= 1} aria-label="Previous page">‹</button>
          <input
            className="page-input"
            value={pageInput}
            aria-label="Page number"
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={commitPage}
            onKeyDown={(e) => e.key === 'Enter' && commitPage()}
          />
          <span className="muted">/ {pageCount}</span>
          <button className="icon" onClick={() => goToPage(Math.min(pageCount, page + 1))} disabled={page >= pageCount} aria-label="Next page">›</button>
        </div>

        <span className="spacer" />

        <div className="tool-group">
          <button className="icon" onClick={() => props.onZoom(Math.max(0.25, zoom - 0.1))} aria-label="Zoom out">−</button>
          <span className="zoom-readout">{Math.round(scale * 100)}%</span>
          <button className="icon" onClick={() => props.onZoom(Math.min(4, zoom + 0.1))} aria-label="Zoom in">+</button>
        </div>
        <button
          className={`icon${fitWidth ? ' on' : ''}`}
          onClick={props.onFitWidth}
          aria-pressed={fitWidth}
          aria-label="Fit to width"
          title="Fit to width (f)"
        >
          ⤢
        </button>
      </div>

      <div className="viewer-scroll" ref={scrollRef} tabIndex={0}>
        {error && <p className="error">Could not render this document: {error}</p>}

        {doc.sourceType === 'image_url' ? (
          <div className="page-stage" style={{ width: fitWidth ? available : undefined }}>
            <img src={doc.dataUri} alt={doc.name} style={{ width: '100%' }} />
          </div>
        ) : (
          <div className="page-column">
            {dims.map((dim, i) => (
              <PageSlot
                key={i}
                ref={(el) => (pageRefs.current[i] = el)}
                index={i}
                pdf={pdf}
                dim={dim}
                scale={scale}
                render={visible.has(i)}
                ocrPage={byIndex.get(i) ?? null}
                showBoxes={showBoxes}
                keepHeader={props.keepHeader}
                keepFooter={props.keepFooter}
                hovered={props.hovered}
                selected={props.selected}
                onHover={props.onHover}
                onSelect={props.onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

interface SlotProps {
  index: number;
  pdf: PDFDocumentProxy | null;
  dim: PageDims;
  scale: number;
  render: boolean;
  ocrPage: OcrPage | null;
  showBoxes: boolean;
  keepHeader: boolean;
  keepFooter: boolean;
  hovered: Selection | null;
  selected: Selection | null;
  onHover: (s: Selection | null) => void;
  onSelect: (s: Selection | null) => void;
}

/**
 * One page in the stack. The slot always occupies its true height — even before it paints —
 * so the scrollbar is correct from the first frame and never jumps as pages stream in.
 *
 * forwardRef is required: a plain function component silently DROPS a `ref` prop, which left
 * the scroll-spy with nothing to observe and broke both scroll tracking and the jump box.
 */
const PageSlot = forwardRef<HTMLDivElement, SlotProps>(function PageSlot(props, ref) {
  const { index, pdf, dim, scale, render, ocrPage, showBoxes } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);

  const w = Math.round(dim.width * scale);
  const h = Math.round(dim.height * scale);

  useEffect(() => {
    if (!pdf || !render) {
      // Out of range: drop the bitmap so a long book doesn't hold every page in memory.
      const canvas = canvasRef.current;
      if (canvas && painted) {
        canvas.width = 0;
        canvas.height = 0;
        setPainted(false);
      }
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;

    (async () => {
      const pdfPage = await pdf.getPage(index + 1);
      if (cancelled) return;

      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      task = pdfPage.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
        if (!cancelled) setPainted(true);
      } catch (err) {
        // A superseded render rejects with RenderingCancelledException — expected.
        if ((err as Error)?.name !== 'RenderingCancelledException') throw err;
      }
    })();

    return () => {
      cancelled = true;
      // Without this the outgoing render keeps painting the canvas the new one draws into.
      task?.cancel();
    };
  }, [pdf, index, scale, render]);

  const blocks = ocrPage ? visibleBlocks(ocrPage, props.keepHeader, props.keepFooter) : [];
  const sx = ocrPage ? w / ocrPage.width : 0;
  const sy = ocrPage ? h / ocrPage.height : 0;

  return (
    <div className="page-slot" ref={ref} data-page-index={index} style={{ width: w, height: h }}>
      <canvas ref={canvasRef} style={{ width: w, height: h }} />
      {!painted && <div className="page-skeleton" aria-hidden />}
      <span className="page-badge">{index + 1}</span>

      {showBoxes && sx > 0 && (
        <div className="overlay">
          {blocks.map((block) => {
            const isHovered = props.hovered?.blockId === block.id;
            const isSelected = props.selected?.blockId === block.id;
            const color = BLOCK_COLORS[block.type];
            return (
              <button
                key={block.id}
                className={`box${isHovered ? ' hovered' : ''}${isSelected ? ' selected' : ''}`}
                style={{
                  left: block.bbox.x * sx,
                  top: block.bbox.y * sy,
                  width: block.bbox.w * sx,
                  height: block.bbox.h * sy,
                  borderColor: color,
                  background: isHovered || isSelected ? `${color}26` : 'transparent',
                }}
                onMouseEnter={() => props.onHover({ pageIndex: index, blockId: block.id })}
                onMouseLeave={() => props.onHover(null)}
                onFocus={() => props.onHover({ pageIndex: index, blockId: block.id })}
                onClick={() =>
                  props.onSelect(isSelected ? null : { pageIndex: index, blockId: block.id })
                }
                aria-label={`${block.type} region on page ${index + 1}`}
              >
                <span className="box-tag" style={{ background: color }}>{block.type}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
