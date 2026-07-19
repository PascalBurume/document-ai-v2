import type { TableMode } from './types';

export interface TableBlock {
  markdown: string;
  html: string;
}

const TABLE_RE = /(^\|.*\|[ \t]*\r?\n^\|[ \t:|-]+\|[ \t]*\r?\n(?:^\|.*\|[ \t]*\r?\n?)+)/gm;

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function tableToHtml(markdown: string): string {
  const rows = markdown.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return '';
  const head = splitRow(rows[0]);
  const body = rows.slice(2).map(splitRow);

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const th = head.map((c) => `      <th>${esc(c)}</th>`).join('\n');
  const tr = body
    .map((cells) => `    <tr>\n${cells.map((c) => `      <td>${esc(c)}</td>`).join('\n')}\n    </tr>`)
    .join('\n');

  return `<table>\n  <thead>\n    <tr>\n${th}\n    </tr>\n  </thead>\n  <tbody>\n${tr}\n  </tbody>\n</table>`;
}

/**
 * Applies the "Extract tables" setting to a page's markdown.
 * - markdown_embedded: untouched, tables stay inline.
 * - markdown_standalone: tables are lifted out and returned separately, leaving a reference.
 * - html_standalone: same, but each table is converted to HTML.
 */
export function applyTableMode(
  markdown: string,
  mode: TableMode,
): { body: string; tables: TableBlock[] } {
  if (mode === 'markdown_embedded') return { body: markdown, tables: [] };

  const tables: TableBlock[] = [];
  const body = markdown.replace(TABLE_RE, (match) => {
    const index = tables.length + 1;
    tables.push({ markdown: match.trim(), html: tableToHtml(match) });
    return `\n_[Table ${index} — extracted below]_\n`;
  });

  return { body, tables };
}
