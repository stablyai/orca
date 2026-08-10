export const SPREADSHEET_GRID_ROW_HEIGHT = 28
export const SPREADSHEET_GRID_OVERSCAN = 12
export const SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX = 48

const MIN_COLUMN_PX = 80
const MAX_COLUMN_PX = 320
const CHARACTER_PX = 7
const CELL_PADDING_PX = 24
// Why: sizing scans values, so it samples the top of the sheet instead of all of
// it. Rare long values below the sample clip with an ellipsis rather than making
// every column wide.
const SAMPLED_ROW_COUNT = 200

export type SpreadsheetColumnWidthsInput = {
  header: readonly string[]
  rows: readonly (readonly string[])[]
  columnCount: number
}

/**
 * Sizes each column to the widest value it was seen holding, so the sticky
 * header and the virtualized body stay aligned on one shared grid template.
 */
export function computeSpreadsheetColumnWidths({
  header,
  rows,
  columnCount
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

  return widths
}

export function buildSpreadsheetGridTemplate(columnWidths: readonly number[]): string {
  return `${SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX}px ${columnWidths.map((width) => `${width}px`).join(' ')}`
}

/** Pads a header row out to the widest row so every column gets a heading cell. */
export function padSpreadsheetHeader(header: readonly string[], columnCount: number): string[] {
  const padded = [...header]
  while (padded.length < columnCount) {
    padded.push('')
  }
  return padded.slice(0, columnCount)
}
