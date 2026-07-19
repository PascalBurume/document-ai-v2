/**
 * A markdown table as a grid you can actually edit.
 *
 * The Edit tab used to hand you the raw source — `| m | -∞ | -1 | 3/11 |` over a row of `| --- |` —
 * and ask you to keep the pipes lined up. That is the one place left in the editor where you fight
 * syntax instead of content, and on a page like the sign tables in this book it is genuinely hard: a
 * single missing `|` silently turns the table back into a paragraph.
 *
 * So: parse to a grid, edit cells, serialize back. Alignment is preserved, ragged rows are squared up
 * to the header, and an escaped `\|` inside a cell stays inside that cell.
 */

export type Align = 'none' | 'left' | 'center' | 'right';

export interface TableGrid {
  header: string[];
  align: Align[];
  rows: string[][];
}

/** Split a row on UNESCAPED pipes, so a cell may legitimately contain `\|`. */
function splitRow(row: string): string[] {
  const out: string[] = [];
  let cell = '';
  const body = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') {
      cell += '\\|';
      i++;
      continue;
    }
    if (c === '|') {
      out.push(cell.trim());
      cell = '';
      continue;
    }
    cell += c;
  }
  out.push(cell.trim());
  return out;
}

function parseAlign(marker: string): Align {
  const m = marker.trim();
  const left = m.startsWith(':');
  const right = m.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'none';
}

const alignMarker = (a: Align): string =>
  a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';

/** Is this line the `| --- | :---: |` separator that makes a markdown table a table? */
const isSeparator = (line: string): boolean => /^\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

/**
 * Parse a GFM table. Returns null when it isn't one — the caller then falls back to editing the
 * source, rather than a grid editor silently mangling something it did not understand.
 */
export function parseTable(src: string): TableGrid | null {
  const lines = src.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2 || !isSeparator(lines[1])) return null;

  const header = splitRow(lines[0]);
  const align = splitRow(lines[1]).map(parseAlign);
  const width = header.length;
  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    // Square the grid to the header: the OCR emits ragged rows, and an editor with holes in it is
    // worse than one that shows you the empty cells.
    while (cells.length < width) cells.push('');
    return cells.slice(0, width);
  });

  return {
    header,
    align: Array.from({ length: width }, (_, i) => align[i] ?? 'none'),
    rows,
  };
}

/** Grid -> markdown. Round-trips a well-formed table; normalises a ragged one. */
export function serializeTable(grid: TableGrid): string {
  const row = (cells: string[]) => `| ${cells.map((c) => c.trim() || ' ').join(' | ')} |`;
  const width = grid.header.length;
  const pad = (cells: string[]) => {
    const next = cells.slice(0, width);
    while (next.length < width) next.push('');
    return next;
  };
  return [
    row(grid.header),
    `| ${Array.from({ length: width }, (_, i) => alignMarker(grid.align[i] ?? 'none')).join(' | ')} |`,
    ...grid.rows.map((r) => row(pad(r))),
  ].join('\n');
}

/* ---------- pure grid operations (the editor's buttons) ---------- */

const blankRow = (width: number) => Array.from({ length: width }, () => '');

export function addRow(grid: TableGrid, at: number): TableGrid {
  const rows = [...grid.rows];
  rows.splice(at, 0, blankRow(grid.header.length));
  return { ...grid, rows };
}

export function removeRow(grid: TableGrid, at: number): TableGrid {
  if (grid.rows.length === 0) return grid;
  return { ...grid, rows: grid.rows.filter((_, i) => i !== at) };
}

export function addColumn(grid: TableGrid, at: number): TableGrid {
  const header = [...grid.header];
  header.splice(at, 0, '');
  const align = [...grid.align];
  align.splice(at, 0, 'none');
  return { header, align, rows: grid.rows.map((r) => { const n = [...r]; n.splice(at, 0, ''); return n; }) };
}

export function removeColumn(grid: TableGrid, at: number): TableGrid {
  if (grid.header.length <= 1) return grid; // a table with no columns is not a table
  return {
    header: grid.header.filter((_, i) => i !== at),
    align: grid.align.filter((_, i) => i !== at),
    rows: grid.rows.map((r) => r.filter((_, i) => i !== at)),
  };
}

export function setCell(grid: TableGrid, row: number, col: number, value: string): TableGrid {
  if (row < 0) return { ...grid, header: grid.header.map((c, i) => (i === col ? value : c)) };
  return {
    ...grid,
    rows: grid.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? value : c)) : r)),
  };
}
