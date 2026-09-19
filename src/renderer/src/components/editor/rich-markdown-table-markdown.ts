import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { markdownCodeSpanRanges } from './markdown-scan-ranges'

type TableCellAlign = 'left' | 'right' | 'center' | null
type TableCell = { text: string; isHeader: boolean; align: TableCellAlign }

const MIN_COLUMN_WIDTH = 3
const OUTLIER_MEDIAN_FACTOR = 2.5
const MAX_COLUMN_WIDTH = 60
const MAX_ALIGNED_TABLE_WIDTH = 160

function collapseWhitespace(value: string): string {
  let offset = 0
  let result = ''
  for (const [start, end] of markdownCodeSpanRanges(value, [])) {
    result += value.slice(offset, start).replace(/\s+/g, ' ') + value.slice(start, end)
    offset = end
  }
  return (result + value.slice(offset).replace(/\s+/g, ' ')).trim()
}

function normalizeAlign(attrs: Record<string, unknown> | undefined): TableCellAlign {
  const value = attrs?.align
  return value === 'left' || value === 'right' || value === 'center' ? value : null
}

function median(sortedLengths: number[]): number {
  const middle = Math.floor(sortedLengths.length / 2)
  return sortedLengths.length % 2 === 0
    ? ((sortedLengths[middle - 1] ?? 0) + (sortedLengths[middle] ?? 0)) / 2
    : (sortedLengths[middle] ?? 0)
}

function naturalColumnWidth(cellLengths: number[], headerLength: number): number {
  return Math.max(MIN_COLUMN_WIDTH, headerLength, ...cellLengths)
}

function clampedColumnWidth(cellLengths: number[], headerLength: number): number {
  const sorted = [...cellLengths].sort((a, b) => a - b)
  const threshold = Math.max(MIN_COLUMN_WIDTH, median(sorted) * OUTLIER_MEDIAN_FACTOR)
  const nonOutliers = cellLengths.filter((length) => length <= threshold)
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, headerLength, ...nonOutliers))
}

function resolveColumnWidths(columns: { cellLengths: number[]; headerLength: number }[]): number[] {
  const natural = columns.map((column) =>
    naturalColumnWidth(column.cellLengths, column.headerLength)
  )
  const pipeOverhead = 3 * columns.length + 1
  if (natural.reduce((sum, width) => sum + width, pipeOverhead) <= MAX_ALIGNED_TABLE_WIDTH) {
    return natural
  }
  return columns.map((column) => clampedColumnWidth(column.cellLengths, column.headerLength))
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

function extractRows(node: JSONContent, helpers: MarkdownRendererHelpers): TableCell[][] {
  return (node.content ?? []).map((rowNode) =>
    (rowNode.content ?? []).map((cellNode) => ({
      text: collapseWhitespace(cellNode.content ? helpers.renderChildren(cellNode.content) : ''),
      isHeader: cellNode.type === 'tableHeader',
      align: normalizeAlign(cellNode.attrs)
    }))
  )
}

export function renderTableToCompactMarkdown(
  node: JSONContent,
  helpers: MarkdownRendererHelpers
): string {
  if (!node.content?.length) {
    return ''
  }
  const rows = extractRows(node, helpers)
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) {
    return ''
  }

  const headerRow = rows[0] ?? []
  const hasHeader = headerRow.some((cell) => cell.isHeader)
  const columns = Array.from({ length: columnCount }, (_, column) => ({
    cellLengths: rows.map((row) => row[column]?.text.length ?? 0),
    headerLength: hasHeader ? (headerRow[column]?.text.length ?? 0) : 0
  }))
  const widths = resolveColumnWidths(columns)
  const alignments = Array.from({ length: columnCount }, (_, column) =>
    rows.reduce<TableCellAlign>((found, row) => found ?? row[column]?.align ?? null, null)
  )
  const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length))
  const formatRow = (row: TableCell[]) =>
    `| ${widths.map((width, column) => pad(row[column]?.text ?? '', width)).join(' | ')} |`
  const header = hasHeader
    ? headerRow
    : Array.from({ length: columnCount }, () => ({ text: '', isHeader: false, align: null }))
  const body = hasHeader ? rows.slice(1) : rows
  return `\n${[
    formatRow(header),
    `| ${widths.map((width, column) => separatorCell(width, alignments[column])).join(' | ')} |`,
    ...body.map(formatRow)
  ].join('\n')}\n`
}
