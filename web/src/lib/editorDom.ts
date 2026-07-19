import type { EditorNode } from './editorNodes';

/**
 * The editor's DOM <-> markdown mapping.
 *
 * This pair MUST round-trip: render then serialize must give back the same markdown, byte for byte.
 * It is not a nicety. The Edit tab re-reads the surface whenever you click an atom, so an unfaithful
 * mapping means *looking* at a formula silently reformats the page around it — text nobody chose to
 * change, changed anyway. That is the exact failure this repo exists to catch.
 *
 * The first version invented structure: it split prose into block <div>s and emitted "\n\n" after each.
 * That is wrong, because most atoms are INLINE — `... : $(1+a)^n \geq 1+na$` is one line, and blocking
 * it inserted a paragraph break before every formula (447 of 570 real pages came back altered). So the
 * model here invents nothing:
 *
 *   text  ->  its exact characters, every "\n" as a <br>
 *   atom  ->  a locked chip carrying its exact source in data-src
 *
 * and serialization is the plain inverse. Blank lines survive because "\n\n" is simply two <br>s.
 * The surface is `white-space: pre-wrap`, so spacing and newlines render as written.
 */

/** HTML-escape text destined for the editable surface. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Nodes -> editable HTML. Flat and faithful: no invented blocks, no invented separators. */
export function renderEditorHtml(
  nodes: EditorNode[],
  crops: Map<number, string>,
  renderFormula: (tex: string) => string,
): string {
  let html = '';
  nodes.forEach((n, i) => {
    if (n.kind === 'text') {
      html += esc(n.src).replace(/\n/g, '<br>');
      return;
    }
    const src = esc(n.src).replace(/"/g, '&quot;');
    if (n.kind === 'formula') {
      html +=
        `<span class="atom atom-formula" contenteditable="false" data-idx="${i}" data-src="${src}" ` +
        `title="Formula — click to see the scan it came from, or edit it">${renderFormula(n.tex ?? '')}</span>`;
    } else if (n.kind === 'image') {
      const crop = crops.get(i);
      const thumb = crop
        ? `<img src="${crop}" alt="${esc(n.alt ?? '')}">`
        : `<span class="atom-fallback">🖼 ${esc(n.ref ?? 'figure')}</span>`;
      html +=
        `<span class="atom atom-figure" contenteditable="false" data-idx="${i}" data-src="${src}" ` +
        `title="Figure — click to see the scan or have it read">${thumb}</span>`;
    } else {
      html +=
        `<span class="atom atom-table" contenteditable="false" data-idx="${i}" data-src="${src}" ` +
        `title="Table — click to edit it as a grid">▦ table</span>`;
    }
  });
  return html;
}

/**
 * Editable HTML -> markdown. Text gives its text, `<br>` a newline, an atom its untouched `data-src` —
 * never a re-rendering of itself, which is what keeps a formula byte-identical through an edit of the
 * sentence beside it.
 *
 * `<div>`/`<p>` only ever appear because a browser made them when someone pressed Enter; they mean one
 * line break, not a paragraph.
 */
export function serializeEditor(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3 /* text */) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (el.dataset?.src != null) {
      out += el.dataset.src;
      return;
    }
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    if ((el.tagName === 'DIV' || el.tagName === 'P') && out && !out.endsWith('\n')) out += '\n';
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out.replace(/\s+$/, '') + '\n';
}
