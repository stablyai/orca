/**
 * How far a cell's text may run past its own column.
 *
 * Why this exists: a spreadsheet does not clip a long label to its column — it
 * lets the text run across the neighbours while they are empty, and stops at the
 * first one that holds something. Truncating at the cell edge instead turns
 * "Presupuesto mensual" into "Presupuesto mens…" in a sheet with four empty
 * columns beside it, which is the single most obvious way a viewer looks wrong.
 */
export type SpreadsheetOverflowInput = {
  row: readonly string[]
  columnIndex: number
  columnCount: number
  /** Widths in pixels by column index, already zoomed. */
  columnWidths: readonly number[]
  /** True when the neighbour carries a fill, which stops the overflow. */
  hasBackground: (columnIndex: number) => boolean
}

// Why: bound the reach so one long label in a sparse sheet cannot produce a span
// wide enough to force a horizontal scrollbar of its own.
const MAX_OVERFLOW_COLUMNS = 12

/**
 * Returns the width the text may occupy — its own column plus every following
 * empty, unfilled one — or null when no neighbour is free, so the caller can keep
 * the cell clipped rather than opting it into an overflow it does not use.
 */
export function computeSpreadsheetTextOverflowWidth({
  row,
  columnIndex,
  columnCount,
  columnWidths,
  hasBackground
}: SpreadsheetOverflowInput): number | null {
  const ownWidth = columnWidths[columnIndex] ?? 0
  let width = ownWidth
  const lastColumn = Math.min(columnCount - 1, columnIndex + MAX_OVERFLOW_COLUMNS)

  for (let next = columnIndex + 1; next <= lastColumn; next += 1) {
    if ((row[next] ?? '') !== '' || hasBackground(next)) {
      break
    }
    width += columnWidths[next] ?? 0
  }

  return width > ownWidth ? width : null
}
