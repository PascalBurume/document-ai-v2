import JSZip from 'jszip';
import type { DocFile } from './types';
import { applyTableMode } from './tables';
import { buildHtml, buildMarkdown } from './convert';
import { effectiveMarkdown } from './editorNodes';
import type { TableMode } from './types';

export function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function copy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * Everything that was paid for, as one zip per document: the raw API response (the evidence), the
 * transcription, the assembled book, and the scans.
 *
 * `book.html` / `book.md` exist because the redrawn figures live on the blocks, not in the OCR
 * markdown — a zip that carried only `document.md` silently dropped every figure recreation in it,
 * which is the most expensive thing in the whole document. Their SVGs are written out individually
 * too, so a figure can be reused without unpicking the book.
 */
export async function downloadAll(docs: DocFile[], tableMode: TableMode) {
  const done = docs.filter((d) => d.result);
  if (!done.length) return;

  const zip = new JSZip();
  for (const doc of done) {
    const folder = zip.folder(stem(doc.name))!;
    folder.file('result.json', JSON.stringify(doc.result!.raw, null, 2));

    const pages = doc.result!.pages.map((p) => {
      const { body, tables } = applyTableMode(effectiveMarkdown(p), tableMode);
      const extracted = tables
        .map((t, i) => `\n\n### Table ${i + 1}\n\n${tableMode === 'html_standalone' ? t.html : t.markdown}`)
        .join('');
      return `<!-- page ${p.index + 1} -->\n\n${body}${extracted}`;
    });
    folder.file('document.md', pages.join('\n\n---\n\n'));

    // The reading view, with every AI recreation inlined and labelled — the same artifact the
    // Book tab's "Save the book" writes.
    folder.file('book.html', buildHtml(doc));
    folder.file('book.md', buildMarkdown(doc));

    if (doc.result!.documentAnnotation) {
      folder.file('annotation.json', JSON.stringify(doc.result!.documentAnnotation, null, 2));
    }

    const images = folder.folder('images')!;
    const figures = folder.folder('figures')!;
    for (const page of doc.result!.pages) {
      for (const block of page.blocks) {
        if (block.redrawnSvg && !block.redrawnStub) {
          figures.file(`p${page.index + 1}-${block.text || block.id}.svg`, block.redrawnSvg);
        }
        if (!block.imageBase64) continue;
        const data = block.imageBase64.replace(/^data:[^,]+,/, '');
        images.file(`p${page.index + 1}-${block.text || block.id}.jpeg`, data, { base64: true });
      }
    }
  }

  save(await zip.generateAsync({ type: 'blob' }), 'document-ai-results.zip');
}
