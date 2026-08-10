export const SPREADSHEET_GRID_ROW_HEIGHT = 28
export const SPREADSHEET_GRID_OVERSCAN = 12
// Why: a couple of columns of overscan is enough horizontally — columns are far
// wider than rows are tall, so few fit on screen and each one costs a cell in
// every rendered row.
export const SPREADSHEET_GRID_COLUMN_OVERSCAN = 3
export const SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX = 48

const MIN_COLUMN_PX = 80
const MAX_COLUMN_PX = 320
const CHARACTER_PX = 7
const CELL_PADDING_PX = 24
// Why: sizing scans values, so it samples the top of the sheet instead of all of
// it. Rare long values below the sample clip with an ellipsis rather than making
// every column wide.
const SAMPLED_ROW_COUNT = 200

export const SPREADSHEET_GRID_BASE_FONT_PX = 13

export type SpreadsheetColumnWidthsInput = {
  header: readonly string[]
  rows: readonly (readonly string[])[]
  columnCount: number
  /**
   * Widths the file itself declares, by column index. A declared width is the
   * author's layout decision and wins over sizing from content.
   */
  declaredColumnWidths?: readonly (number | undefined)[]
  /** Multiplier from the editor zoom level; 1 at the default font size. */
  zoomScale?: number
}

/**
 * Sizes each column to the widest value it was seen holding, so the sticky
 * header and the virtualized body stay aligned on one shared grid template.
 */
export function computeSpreadsheetColumnWidths({
  header,
  rows,
  columnCount,
  declaredColumnWidths,
  zoomScale = 1
}: SpreadsheetColumnWidthsInput): number[] {
  const widths = Array.from<number>({ length: columnCount }).fill(MIN_COLUMN_PX)
  const consider = (cell: string | undefined, columnIndex: number): void => {
    if (!cell || columnIndex >= columnCount) {
      return
    }
    const width = Math.min(
      MAX_COLUMN_PX,
      Math.max(MIN_COLUMN_PX, cell.length * CHARACTER_PX + CELL_PADDING_PX)
    )
    if (width > widths[columnIndex]!) {
      widths[columnIndex] = width
    }
  }

  header.forEach(consider)
  const sampleLimit = Math.min(rows.length, SAMPLED_ROW_COUNT)
  for (let rowIndex = 0; rowIndex < sampleLimit; rowIndex += 1) {
    const row = rows[rowIndex]!
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      consider(row[columnIndex], columnIndex)
    }
  }

  return widths.map((width, columnIndex) =>
    Math.round((declaredColumnWidths?.[columnIndex] ?? width) * zoomScale)
  )
}

export type SpreadsheetGridTemplateInput = {
  /** Widths of the columns actually rendered, in order. */
  columnWidths: readonly number[]
  /** Width of the sticky row-number column, which scales with the zoom level. */
  rowNumberColumnPx?: number
  /** Width of the columns scrolled off to the left, collapsed into one spacer. */
  leadingSpacerPx?: number
  /** Width of the columns still off to the right. */
  trailingSpacerPx?: number
}

/**
 * Builds the row template: the sticky row-number column, a spacer standing in
 * for the columns scrolled past, the rendered columns, then a spacer for the
 * rest.
 *
 * Why spacers instead of one entry per column: a sheet whose last used cell sits
 * far to the right has thousands of columns, and a full template would put a
 * six-figure-character string in the inline style of every rendered row.
 */
export function buildSpreadsheetGridTemplate({
  columnWidths,
  rowNumberColumnPx = SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX,
  leadingSpacerPx = 0,
  trailingSpacerPx = 0
}: SpreadsheetGridTemplateInput): string {
  return [
    `${rowNumberColumnPx}px`,
    `${leadingSpacerPx}px`,
    ...columnWidths.map((width) => `${width}px`),
    `${trailingSpacerPx}px`
  ].join(' ')
}

/** Pads a header row out to the widest row so every column gets a heading cell. */
export function padSpreadsheetHeader(header: readonly string[], columnCount: number): string[] {
  const padded = [...header]
  while (padded.length < columnCount) {
    padded.push('')
  }
  return padded.slice(0, columnCount)
}
