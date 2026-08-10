// Replaces @tiptap/extension-table's default table serializer, whose column
// width is the LONGEST cell in the column — so one long cell pads every sibling
// (and the separator dash-run) out to its length. This version aligns to each
// column's longest NON-OUTLIER cell so a lone long cell overflows instead of
// stretching the whole column, with a ceiling for uniformly-huge columns.

import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'

// getMarkdown() serializes getJSON() output, so renderMarkdown receives a
// JSONContent tree: `type` is a string, `content` an array, `attrs` a plain object.
type TableCellAlign = 'left' | 'right' | 'center' | null

type TableCell = { text: string; isHeader: boolean; align: TableCellAlign }

const MIN_COLUMN_WIDTH = 3
// A cell longer than this multiple of its column's median is an outlier: it
// overflows its column instead of dictating the padding for every other cell.
const OUTLIER_MEDIAN_FACTOR = 2.5
// Hard ceiling so a column where every cell is genuinely huge doesn't pad short
// cells (and the separator) out to hundreds of characters.
const MAX_COLUMN_WIDTH = 60
// If a fully-aligned table (every column padded to its longest cell) fits within
// this width, align it — the runaway padding only hurts once a table is wide, so
// a narrow table has no reason to clamp and should keep every column lined up.
const MAX_ALIGNED_TABLE_WIDTH = 160

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeAlign(attrs: Record<string, unknown> | undefined): TableCellAlign {
  const value = attrs?.align
  return value === 'left' || value === 'right' || value === 'center' ? value : null
}

function median(sortedLengths: number[]): number {
  const count = sortedLengths.length
  if (count === 0) {
    return 0
  }
  const mid = Math.floor(count / 2)
  return count % 2 ? sortedLengths[mid] : (sortedLengths[mid - 1] + sortedLengths[mid]) / 2
}

// Full alignment: pad to the longest cell (always fitting the header).
function naturalColumnWidth(cellLengths: number[], headerLength: number): number {
  return Math.max(MIN_COLUMN_WIDTH, headerLength, ...cellLengths)
}

// Clamped width = longest non-outlier cell, always fitting the header, capped at
// the ceiling. Header length is passed separately so a header is never treated as
// an outlier and never overflows its own column.
function clampedColumnWidth(cellLengths: number[], headerLength: number): number {
  const sorted = [...cellLengths].sort((a, b) => a - b)
  const outlierThreshold = Math.max(MIN_COLUMN_WIDTH, median(sorted) * OUTLIER_MEDIAN_FACTOR)
  const nonOutlierLengths = cellLengths.filter((length) => length <= outlierThreshold)
  const contentWidth = Math.max(MIN_COLUMN_WIDTH, headerLength, ...nonOutlierLengths)
  return Math.min(MAX_COLUMN_WIDTH, contentWidth)
}

// Pipe overhead of a row: leading "| ", trailing " |", and " | " between columns.
function rowPipeOverhead(columnCount: number): number {
  return 3 * columnCount + 1
}

// Align every column to its content when the table stays narrow; only clamp
// outliers once full alignment would exceed the width budget.
function resolveColumnWidths(columns: { cellLengths: number[]; headerLength: number }[]): number[] {
  const natural = columns.map((col) => naturalColumnWidth(col.cellLengths, col.headerLength))
  const naturalTotal =
    natural.reduce((sum, width) => sum + width, 0) + rowPipeOverhead(columns.length)
  if (naturalTotal <= MAX_ALIGNED_TABLE_WIDTH) {
    return natural
  }
  return columns.map((col) => clampedColumnWidth(col.cellLengths, col.headerLength))
}

function extractRows(node: JSONContent, h: MarkdownRendererHelpers): TableCell[][] {
  const rows: TableCell[][] = []
  for (const rowNode of node.content ?? []) {
    const cells: TableCell[] = []
    for (const cellNode of rowNode.content ?? []) {
      const raw = cellNode.content ? h.renderChildren(cellNode.content) : ''
      cells.push({
        text: collapseWhitespace(raw),
        isHeader: cellNode.type === 'tableHeader',
        align: normalizeAlign(cellNode.attrs)
      })
    }
    rows.push(cells)
  }
  return rows
}

function separatorCell(width: number, align: TableCellAlign): string {
  // Colons count toward the column width so the separator row stays exactly as
  // wide as the content rows (adding them on top would widen aligned columns).
  const colons = align === 'center' ? 2 : align ? 1 : 0
  const dashes = '-'.repeat(Math.max(1, width - colons))
  if (align === 'left') {
    return `:${dashes}`
  }
  if (align === 'right') {
    return `${dashes}:`
  }
  if (align === 'center') {
    return `:${dashes}:`
  }
  return dashes
}

export function renderTableToCompactMarkdown(
  node: JSONContent,
  h: MarkdownRendererHelpers
): string {
  if (!node?.content || node.content.length === 0) {
    return ''
  }
  const rows = extractRows(node, h)
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) {
    return ''
  }

  const headerRow = rows[0]
  const hasHeader = headerRow.some((cell) => cell.isHeader)

  const columns = Array.from({ length: columnCount }, (_unused, col) => ({
    cellLengths: rows.map((row) => row[col]?.text.length ?? 0),
    headerLength: hasHeader ? (headerRow[col]?.text.length ?? 0) : 0
  }))
  const columnWidths = resolveColumnWidths(columns)
  // First explicit alignment wins, matching the default serializer.
  const columnAlignments: TableCellAlign[] = Array.from({ length: columnCount }, (_unused, col) =>
    rows.reduce<TableCellAlign>((found, row) => found ?? row[col]?.align ?? null, null)
  )

  const pad = (text: string, width: number): string =>
    text + ' '.repeat(Math.max(0, width - text.length))
  const formatRow = (row: TableCell[]): string =>
    `| ${columnWidths.map((width, col) => pad(row[col]?.text ?? '', width)).join(' | ')} |`

  const headerTexts: TableCell[] = hasHeader
    ? headerRow
    : Array.from({ length: columnCount }, () => ({ text: '', isHeader: false, align: null }))
  const bodyRows = hasHeader ? rows.slice(1) : rows

  const lines = [
    formatRow(headerTexts),
    `| ${columnWidths.map((width, col) => separatorCell(width, columnAlignments[col])).join(' | ')} |`,
    ...bodyRows.map(formatRow)
  ]
  return `\n${lines.join('\n')}\n`
}
