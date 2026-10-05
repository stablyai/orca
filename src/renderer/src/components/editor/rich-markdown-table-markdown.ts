import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'

type TableCellAlign = 'left' | 'right' | 'center' | null

type TableCell = { text: string; isHeader: boolean; align: TableCellAlign }

const MIN_COLUMN_WIDTH = 3
const OUTLIER_MEDIAN_FACTOR = 2.5
const MAX_COLUMN_WIDTH = 60
// Long cells keep their text while short siblings receive bounded padding.
const MAX_ALIGNED_TABLE_WIDTH = 160

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function escapeCellPipes(value: string): string {
  return value.replace(/(\\*)\|/g, (match, slashes: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\|` : match
  )
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

function naturalColumnWidth(cellLengths: number[], headerLength: number): number {
  return cellLengths.reduce(
    (width, length) => Math.max(width, length),
    Math.max(MIN_COLUMN_WIDTH, headerLength)
  )
}

function clampedColumnWidth(cellLengths: number[], headerLength: number): number {
  const sorted = [...cellLengths].sort((a, b) => a - b)
  const outlierThreshold = Math.max(MIN_COLUMN_WIDTH, median(sorted) * OUTLIER_MEDIAN_FACTOR)
  const nonOutlierLengths = cellLengths.filter((length) => length <= outlierThreshold)
  const contentWidth = naturalColumnWidth(nonOutlierLengths, headerLength)
  return Math.min(MAX_COLUMN_WIDTH, contentWidth)
}

function rowPipeOverhead(columnCount: number): number {
  return 3 * columnCount + 1
}

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
      const blocks = cellNode.content ?? []
      const raw =
        blocks.length > 1
          ? blocks.map((child) => h.renderChildren(child)).join('\n')
          : h.renderChildren(blocks)
      cells.push({
        text: escapeCellPipes(collapseWhitespace(raw.replace(/[ \t]*\r?\n[ \t]*/g, '<br>'))),
        isHeader: cellNode.type === 'tableHeader',
        align: normalizeAlign(cellNode.attrs)
      })
    }
    rows.push(cells)
  }
  return rows
}

function separatorCell(width: number, align: TableCellAlign): string {
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
