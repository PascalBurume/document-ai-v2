import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown, safeKatex } from '../lib/markdown';
import { effectiveMarkdown, isEdited, parsePageToNodes, formulaSrc, type EditorNode } from '../lib/editorNodes';
import { renderEditorHtml, serializeEditor } from '../lib/editorDom';
import {
  parseTable,
  serializeTable,
  addRow,
  removeRow,
  addColumn,
  removeColumn,
  setCell,
  type TableGrid,
} from '../lib/tableGrid';
import { figureCropDataUri } from '../lib/figure';
import { renderPageToImage } from '../lib/pdf';
import { recoverFigureText } from '../lib/vision';
import type { Block, DocFile, OcrPage } from '../lib/types';

/**
 * The Edit tab: correct a page's text without being able to break what you can't read.
 *
 * The premise of the whole repo is that OCR text is a *claim* you must check against the scan. That
 * cuts both ways for editing: the person fixing a sentence usually cannot read `$\frac{\sqrt2}{2}$`
 * or `![img-0.jpeg](img-0.jpeg)`, so a plain text box invites them to silently mangle a formula while
 * "just fixing a typo". So:
 *
 *  - prose is freely editable;
 *  - every formula/figure is a LOCKED chip (contenteditable=false) rendered as the real thing, and is
 *    written back byte-for-byte from `data-src` unless the user deliberately opens it;
 *  - any chip can show the exact scan region it came from — the answer to "what even is this?";
 *  - editing is NON-DESTRUCTIVE: `page.markdown` (the OCR claim the inspector grades) is never
 *    touched; the correction lives in `page.editedMarkdown`.
 */

/* ---------- the symbol palette: LaTeX without knowing LaTeX ---------- */

const PALETTE: { label: string; snippet: string; title: string }[] = [
  { label: '√', snippet: '\\sqrt{}', title: 'square root' },
  { label: 'a⁄b', snippet: '\\frac{}{}', title: 'fraction' },
  { label: 'x²', snippet: '^{2}', title: 'exponent' },
  { label: 'xₙ', snippet: '_{n}', title: 'subscript' },
  { label: '×10ⁿ', snippet: '\\times 10^{}', title: 'power of ten' },
  { label: '≤', snippet: '\\leq ', title: 'less or equal' },
  { label: '≥', snippet: '\\geq ', title: 'greater or equal' },
  { label: '≠', snippet: '\\neq ', title: 'not equal' },
  { label: '×', snippet: '\\times ', title: 'times' },
  { label: '÷', snippet: '\\div ', title: 'divide' },
  { label: 'π', snippet: '\\pi ', title: 'pi' },
  { label: 'α', snippet: '\\alpha ', title: 'alpha' },
  { label: 'Δ', snippet: '\\Delta ', title: 'delta' },
  { label: '∞', snippet: '\\infty ', title: 'infinity' },
  { label: '∑', snippet: '\\sum_{}^{}', title: 'sum' },
  { label: '∫', snippet: '\\int_{}^{}', title: 'integral' },
];

/* ---------- the table grid editor ---------- */

/**
 * Editing a table used to mean keeping `|` pipes lined up by hand. Now it's a grid: type in the cell
 * you mean, add or drop rows and columns with a button, and watch the real rendered table update
 * underneath — with the scan crop right there to copy from. A cell is just text, so `$\frac{3}{11}$`
 * still works and the palette can type it for you.
 */
function TableEditor({
  grid,
  onGrid,
  onFocusCell,
}: {
  grid: TableGrid;
  onGrid: (g: TableGrid) => void;
  onFocusCell: (el: HTMLInputElement | null) => void;
}) {
  const cell = (value: string, row: number, col: number) => (
    <input
      className="tg-cell"
      value={value}
      onFocus={(e) => onFocusCell(e.currentTarget)}
      onChange={(e) => onGrid(setCell(grid, row, col, e.target.value))}
    />
  );

  return (
    <div className="table-grid">
      <div className="tg-scroll">
        <table>
          <thead>
            <tr>
              <th className="tg-corner" />
              {grid.header.map((h, c) => (
                <th key={c}>
                  <div className="tg-colhead">
                    {cell(h, -1, c)}
                    <button
                      className="tg-mini"
                      title="Remove this column"
                      onClick={() => onGrid(removeColumn(grid, c))}
                      disabled={grid.header.length <= 1}
                    >
                      ×
                    </button>
                  </div>
                </th>
              ))}
              <th className="tg-corner">
                <button className="tg-mini" title="Add a column" onClick={() => onGrid(addColumn(grid, grid.header.length))}>
                  ＋
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={r}>
                <td className="tg-rowhead">
                  <button className="tg-mini" title="Remove this row" onClick={() => onGrid(removeRow(grid, r))}>
                    ×
                  </button>
                </td>
                {row.map((v, c) => (
                  <td key={c}>{cell(v, r, c)}</td>
                ))}
                <td />
              </tr>
            ))}
            <tr>
              <td className="tg-rowhead">
                <button className="tg-mini" title="Add a row" onClick={() => onGrid(addRow(grid, grid.rows.length))}>
                  ＋
                </button>
              </td>
              <td className="tg-addhint muted" colSpan={grid.header.length + 1}>
                add a row
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- the atom popover ---------- */

interface AtomPopoverProps {
  node: EditorNode;
  crop: string | null;
  cropPending: boolean;
  context: string;
  onApply: (src: string) => void;
  onClose: () => void;
}

/**
 * The answer to "this formula/figure means nothing to me". It shows the atom rendered, the exact
 * scan region it came from, and — for a formula — a live preview + a click-to-insert palette so it
 * can be corrected without knowing LaTeX. Leaving it alone is always the default.
 */
function AtomPopover({ node, crop, cropPending, context, onApply, onClose }: AtomPopoverProps) {
  const [tex, setTex] = useState(node.tex ?? '');
  const [alt, setAlt] = useState(node.alt ?? '');
  const [reading, setReading] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);
  const texRef = useRef<HTMLTextAreaElement>(null);
  // A table opens as a grid when it parses as one, and as its source when it doesn't.
  const [grid, setGrid] = useState<TableGrid | null>(() => (node.kind === 'table' ? parseTable(node.src) : null));
  const [rawTable, setRawTable] = useState(node.src);
  const cellRef = useRef<HTMLInputElement | null>(null);

  const preview = useMemo(() => safeKatex(tex, true), [tex]);

  /** Palette insert for the table grid: types into whichever cell was last focused. */
  const insertIntoCell = (snippet: string) => {
    const el = cellRef.current;
    if (!el || !grid) return;
    const at = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? at;
    const next = el.value.slice(0, at) + snippet + el.value.slice(end);
    // Locate the cell from the DOM position rather than threading indices through the palette.
    const td = el.closest('td, th');
    const tr = el.closest('tr');
    if (!td || !tr) return;
    const col = [...tr.children].indexOf(td) - 1; // first column is the row handle
    const body = el.closest('tbody');
    const row = body ? [...body.querySelectorAll('tr')].indexOf(tr) : -1;
    setGrid(setCell(grid, body ? row : -1, col, next));
    const brace = snippet.indexOf('{}');
    const caret = at + (brace >= 0 ? brace + 1 : snippet.length);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const insert = (snippet: string) => {
    const el = texRef.current;
    const at = el ? el.selectionStart : tex.length;
    const next = tex.slice(0, at) + snippet + tex.slice(el ? el.selectionEnd : tex.length);
    setTex(next);
    // Drop the caret inside the first {} of the snippet — where you'd actually type next.
    const brace = snippet.indexOf('{}');
    const caret = at + (brace >= 0 ? brace + 1 : snippet.length);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const readFigure = async () => {
    if (!crop) return;
    setReading(true);
    setReadErr(null);
    try {
      const r = await recoverFigureText(crop, context.slice(0, 2500));
      setRecovered(r.markdown || '(the model returned nothing readable)');
    } catch (e) {
      setReadErr((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const scan = (
    <div className="atom-scan">
      <div className="atom-scan-head">🔍 What's printed on the scan here</div>
      {cropPending ? (
        <p className="muted tiny">Rendering the region…</p>
      ) : crop ? (
        <img src={crop} alt="scan region" />
      ) : (
        <p className="muted tiny">No scan region available for this atom.</p>
      )}
    </div>
  );

  return (
    <div className="atom-popover-backdrop" onClick={onClose}>
      <div className="atom-popover" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit atom">
        {node.kind === 'formula' ? (
          <>
            <div className="atom-preview" dangerouslySetInnerHTML={{ __html: preview }} />
            <div className="palette">
              {PALETTE.map((p) => (
                <button key={p.label} className="pal" title={p.title} onClick={() => insert(p.snippet)}>
                  {p.label}
                </button>
              ))}
            </div>
            <textarea
              ref={texRef}
              className="code-editor tex"
              spellCheck={false}
              rows={3}
              value={tex}
              onChange={(e) => setTex(e.target.value)}
            />
            {scan}
            <p className="atom-foot">
              The preview above is the same renderer the page uses — if it looks right, it is right. Not
              sure? Leave it alone; Cancel changes nothing.
            </p>
            <div className="atom-actions">
              <button className="btn tiny" onClick={onClose}>Cancel</button>
              <button className="btn tiny primary" onClick={() => onApply(formulaSrc(tex, Boolean(node.display)))}>
                Apply formula
              </button>
            </div>
          </>
        ) : node.kind === 'image' ? (
          <>
            {scan}
            <label className="field">
              <span>Caption / description</span>
              <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="describe the figure" />
            </label>
            <div className="atom-read">
              <button className="btn tiny ghost" onClick={() => void readFigure()} disabled={reading || !crop}>
                {reading ? 'Reading the figure…' : '🔍 Read this figure'}
              </button>
              {readErr && <p className="vision-err">{readErr}</p>}
              {recovered && (
                <div className="recovered">
                  <p className="tiny muted">A vision model read the figure. This is a suggestion, not evidence:</p>
                  <pre>{recovered}</pre>
                  <button className="btn tiny" onClick={() => setAlt(recovered.replace(/\s+/g, ' ').slice(0, 200))}>
                    Use as caption
                  </button>
                </div>
              )}
            </div>
            <p className="atom-foot">The image itself is never altered — only its caption.</p>
            <div className="atom-actions">
              <button className="btn tiny" onClick={onClose}>Cancel</button>
              <button className="btn tiny primary" onClick={() => onApply(`![${alt}](${node.ref ?? ''})`)}>
                Apply caption
              </button>
            </div>
          </>
        ) : (
          <>
            {grid ? (
              <>
                <TableEditor grid={grid} onGrid={setGrid} onFocusCell={(el) => (cellRef.current = el)} />
                <div className="palette">
                  {PALETTE.map((p) => (
                    <button key={p.label} className="pal" title={`${p.title} — into the selected cell`} onClick={() => insertIntoCell(p.snippet)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="tg-preview">
                  <div className="atom-scan-head">How it will render</div>
                  <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(serializeTable(grid)) }} />
                </div>
              </>
            ) : (
              <>
                <p className="atom-foot">
                  This one isn't a table the grid editor can read, so here is its source — rather than have
                  the grid quietly mangle something it didn't understand.
                </p>
                <textarea
                  className="code-editor"
                  spellCheck={false}
                  rows={8}
                  value={rawTable}
                  onChange={(e) => setRawTable(e.target.value)}
                />
              </>
            )}
            {scan}
            <p className="atom-foot">
              Type in a cell; the table underneath is the real rendering. Cells take math too —{' '}
              <code>{'$\\frac{3}{11}$'}</code> — and the buttons above type it into the cell you selected.
            </p>
            <div className="atom-actions">
              <button className="btn tiny" onClick={onClose}>Cancel</button>
              <button
                className="btn tiny primary"
                onClick={() => onApply(grid ? serializeTable(grid) : rawTable)}
              >
                Apply table
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- the tab ---------- */

interface Props {
  doc: DocFile;
  page: OcrPage;
  blocks: Block[];
  onEdit: (pageIndex: number, patch: Partial<OcrPage>) => void;
}

export function EditTab({ doc, page, blocks, onEdit }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(() => effectiveMarkdown(page));
  const [openAtom, setOpenAtom] = useState<number | null>(null);
  const [rightView, setRightView] = useState<'preview' | 'scan'>('preview');
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const [crops, setCrops] = useState<Map<number, string>>(new Map());
  const [cropPending, setCropPending] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Re-parse only when the committed draft changes — typing inside the surface must not re-render it
  // underneath the caret.
  const nodes = useMemo(() => parsePageToNodes(draft), [draft]);

  // Reset when the page changes.
  useEffect(() => {
    setDraft(effectiveMarkdown(page));
    setDirty(false);
    setOpenAtom(null);
    setCrops(new Map());
  }, [page.index, page.editedMarkdown]);

  const images = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of blocks) if (b.imageBase64) m.set(b.text, b.imageBase64);
    return m;
  }, [blocks]);

  /**
   * The block whose region best corresponds to an atom — this is what the scan crop is taken from, so
   * getting it right IS the "what's printed here?" feature. Matching is by CONTENT, never by type
   * alone: a formula is just as often inline inside a `text` block ("Soit l'équation $ax^2+bx+c=0$")
   * as it is its own `equation` block, and a page with four tables has four `table` blocks, so
   * "the first one of the right type" would happily show the wrong region.
   */
  const blockForNode = useCallback(
    (n: EditorNode): Block | null => {
      if (n.kind === 'image' && n.ref) {
        return blocks.find((b) => b.type === 'image' && (b.text.includes(n.ref!) || b.text === n.ref)) ?? null;
      }
      if (n.kind === 'formula') {
        // The exact source is the most reliable needle; fall back to the bare TeX.
        const bySrc = blocks.find((b) => b.text.includes(n.src));
        if (bySrc) return bySrc;
        const tex = n.tex?.trim();
        return (tex && blocks.find((b) => b.text.includes(tex))) || null;
      }
      if (n.kind === 'table') {
        // Identify THIS table by its header row, not by "the first table on the page".
        const header = n.src.split('\n')[0]?.trim();
        if (header) {
          const byHeader = blocks.find((b) => b.type === 'table' && b.text.includes(header));
          if (byHeader) return byHeader;
        }
        return blocks.find((b) => b.type === 'table') ?? null;
      }
      return null;
    },
    [blocks],
  );

  // Crop the scan for whichever atom is open — the "what is this?" answer, rendered from the PDF.
  useEffect(() => {
    if (openAtom == null) return;
    const n = nodes[openAtom];
    if (!n) return;
    let cancelled = false;
    if (crops.has(openAtom)) return;
    const block = blockForNode(n);
    setCropPending(true);
    (async () => {
      try {
        const uri = block
          ? await figureCropDataUri(doc, page, block)
          : await renderPageToImage(doc.id, doc.dataUri, page.index);
        if (!cancelled) setCrops((prev) => new Map(prev).set(openAtom, uri));
      } catch {
        /* leave it absent; the popover says so */
      } finally {
        if (!cancelled) setCropPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openAtom, nodes, blockForNode, doc, page, crops]);

  // The whole-page scan for the right pane.
  useEffect(() => {
    if (rightView !== 'scan' || scanUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const uri =
          doc.sourceType === 'image_url' ? doc.dataUri : await renderPageToImage(doc.id, doc.dataUri, page.index);
        if (!cancelled) setScanUrl(uri);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rightView, scanUrl, doc, page.index]);

  useEffect(() => setScanUrl(null), [page.index]);

  const editorHtml = useMemo(
    () => renderEditorHtml(nodes, crops, (tex) => safeKatex(tex, false)),
    [nodes, crops],
  );

  /** Pull the current text out of the surface without re-rendering it (that would kill the caret). */
  const readSurface = () => (editorRef.current ? serializeEditor(editorRef.current) : draft);

  const commit = useCallback(
    (next: string) => {
      setDraft(next);
      setDirty(false);
      // Never write `markdown` — only the edit layer. An edit equal to the OCR clears the layer.
      onEdit(page.index, { editedMarkdown: next === page.markdown ? undefined : next });
    },
    [onEdit, page.index, page.markdown],
  );

  const onAtomClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.('.atom') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    // Take whatever the user has typed so far before we re-render around the atom.
    setDraft(readSurface());
    setOpenAtom(Number(el.dataset.idx));
  };

  const applyAtom = (src: string) => {
    if (openAtom == null) return;
    const next = nodes.map((n, i) => (i === openAtom ? { ...n, src } : n));
    const md = next.map((n) => n.src).join('');
    setOpenAtom(null);
    commit(md);
  };

  const previewHtml = useMemo(() => renderMarkdown(draft, images), [draft, images]);
  const edited = isEdited({ markdown: page.markdown, editedMarkdown: page.editedMarkdown });

  return (
    <div className="edit-tab">
      <div className="edit-bar">
        <span className="edit-title">Editing page {page.index + 1}</span>
        {edited && <span className="chip edited">✎ edited</span>}
        {dirty && <span className="chip unsaved">unsaved</span>}
        <span className="spacer" />
        <button className="btn tiny" disabled={!dirty} onClick={() => commit(readSurface())}>
          Save
        </button>
        <button
          className="btn tiny"
          disabled={!edited}
          title="Throw away the edit and go back to exactly what the OCR returned"
          onClick={() => {
            setOpenAtom(null);
            setDraft(page.markdown);
            setDirty(false);
            onEdit(page.index, { editedMarkdown: undefined });
          }}
        >
          ↺ Revert to OCR
        </button>
      </div>

      <p className="edit-hint">
        Type to fix the text. Formulas and figures are locked — click one to see the scan it came from, or
        to edit it. The OCR original is always kept underneath.
      </p>

      <div className="edit-panes">
        <div
          ref={editorRef}
          className="edit-surface"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          onClick={onAtomClick}
          onInput={() => setDirty(true)}
          onBlur={() => dirty && commit(readSurface())}
          dangerouslySetInnerHTML={{ __html: editorHtml }}
        />

        <div className="edit-preview">
          <div className="segmented edit-toggle">
            <button className={rightView === 'preview' ? 'on' : ''} onClick={() => setRightView('preview')}>
              Preview
            </button>
            <button className={rightView === 'scan' ? 'on' : ''} onClick={() => setRightView('scan')}>
              Scan
            </button>
          </div>
          {rightView === 'preview' ? (
            <div className="prose" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          ) : scanUrl ? (
            <img className="edit-scan" src={scanUrl} alt={`scan of page ${page.index + 1}`} />
          ) : (
            <p className="muted tiny pad">Rendering the scan…</p>
          )}
        </div>
      </div>

      {openAtom != null && nodes[openAtom] && (
        <AtomPopover
          node={nodes[openAtom]}
          crop={crops.get(openAtom) ?? null}
          cropPending={cropPending}
          context={page.markdown}
          onApply={applyAtom}
          onClose={() => setOpenAtom(null)}
        />
      )}
    </div>
  );
}
