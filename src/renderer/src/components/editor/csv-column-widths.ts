const AUTO_MIN_COLUMN_WIDTH = 80
const AUTO_MAX_COLUMN_WIDTH = 320
const CELL_HORIZONTAL_PADDING = 24
const CHARACTER_WIDTH = 7

export const MIN_CSV_COLUMN_WIDTH = AUTO_MIN_COLUMN_WIDTH
export const CSV_ROW_NUMBER_COLUMN_WIDTH = 48

// Sample a bounded prefix so opening a large CSV does not scan every cell.
// Manual resizing is not subject to the automatic 320px cap.
export function getCsvColumnWidths(
  header: readonly string[],
  bodyRows: readonly string[][],
  columnCount: number
): number[] {
  const widths = Array.from<number>({ length: columnCount }).fill(AUTO_MIN_COLUMN_WIDTH)
  const consider = (cell: string | undefined, index: number): void => {
    if (!cell) {
      return
    }
    const width = Math.min(
      AUTO_MAX_COLUMN_WIDTH,
      Math.max(AUTO_MIN_COLUMN_WIDTH, cell.length * CHARACTER_WIDTH + CELL_HORIZONTAL_PADDING)
    )
    if (width > widths[index]!) {
      widths[index] = width
    }
  }

  header.forEach(consider)
  const sampleLimit = Math.min(bodyRows.length, 200)
  for (let rowIndex = 0; rowIndex < sampleLimit; rowIndex += 1) {
    const row = bodyRows[rowIndex]!
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      consider(row[columnIndex], columnIndex)
    }
  }
  return widths
}

export function getCsvGridTemplate(columnWidths: readonly number[]): string {
  return `${CSV_ROW_NUMBER_COLUMN_WIDTH}px ${columnWidths.map((width) => `${width}px`).join(' ')}`
}
