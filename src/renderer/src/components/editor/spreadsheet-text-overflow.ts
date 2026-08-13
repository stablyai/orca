/**
 * How far a cell's text may run past its own column.
 *
 * Why this exists: a spreadsheet does not clip a long label to its column — it
 * lets the text run across the neighbours while they are empty, and stops at the
 * first one that holds something. Truncating at the cell edge instead turns
 * "Presupuesto mensual" into "Presupuesto mens…" in a sheet with four empty
 * columns beside it, which is the single most obvious way a viewer looks wrong.
 *
 * The direction follows the alignment, as it does in Excel: a left-aligned label
 * spills right, a right-aligned one spills left, and a centred one both ways.
 * Only ever spilling right left every right-aligned heading clipped even with an
 * empty column beside it.
 */
export type SpreadsheetOverflowInput = {
  row: readonly string[]
  columnIndex: number
  columnCount: number
  /** Widths in pixels by column index, already zoomed. */
  columnWidths: readonly number[]
  /**
   * True when the neighbour belongs to a merged range, which owns its cell even
   * when the value lives in the merge's anchor rather than in this row.
   */
  isMerged: (columnIndex: number) => boolean
  /** Which way the text is drawn from, which decides where it may spill. */
  alignment?: 'left' | 'right' | 'center'
  /**
   * Last column the text already covers. A merge's value spans its columns before
   * it starts spilling, so the reach has to begin past the whole merge.
   */
  throughColumnIndex?: number
}

// Why: bound the reach so one long label in a sparse sheet cannot produce a span
// wide enough to force a horizontal scrollbar of its own.
const MAX_OVERFLOW_COLUMNS = 12

/**
 * Returns the width the text may occupy — the columns it already covers plus
 * every free one in the direction it spills — or null when no neighbour is free,
 * so the caller can keep the cell clipped rather than opting it into an overflow
 * it does not use.
 *
 * Why a fill does not stop it: a spreadsheet paints an overflowing label straight
 * over a coloured neighbour, and treating a fill as occupied clipped headings
 * that sat beside a banded but empty range.
 */
export function computeSpreadsheetTextOverflowWidth({
  row,
  columnIndex,
  columnCount,
  columnWidths,
  isMerged,
  alignment = 'left',
  throughColumnIndex
}: SpreadsheetOverflowInput): number | null {
  const lastCovered = Math.max(columnIndex, throughColumnIndex ?? columnIndex)
  let ownWidth = 0
  for (let covered = columnIndex; covered <= lastCovered; covered += 1) {
    ownWidth += columnWidths[covered] ?? 0
  }

  let width = ownWidth
  if (alignment !== 'right') {
    width += reachAfter(row, columnWidths, isMerged, lastCovered, columnCount)
  }
  if (alignment !== 'left') {
    width += reachBefore(row, columnWidths, isMerged, columnIndex)
  }

  return width > ownWidth ? width : null
}

function reachAfter(
  row: readonly string[],
  columnWidths: readonly number[],
  isMerged: (columnIndex: number) => boolean,
  from: number,
  columnCount: number
): number {
  let reach = 0
  const lastColumn = Math.min(columnCount - 1, from + MAX_OVERFLOW_COLUMNS)
  for (let next = from + 1; next <= lastColumn; next += 1) {
    if ((row[next] ?? '') !== '' || isMerged(next)) {
      break
    }
    reach += columnWidths[next] ?? 0
  }
  return reach
}

function reachBefore(
  row: readonly string[],
  columnWidths: readonly number[],
  isMerged: (columnIndex: number) => boolean,
  from: number
): number {
  let reach = 0
  const firstColumn = Math.max(0, from - MAX_OVERFLOW_COLUMNS)
  for (let previous = from - 1; previous >= firstColumn; previous -= 1) {
    if ((row[previous] ?? '') !== '' || isMerged(previous)) {
      break
    }
    reach += columnWidths[previous] ?? 0
  }
  return reach
}
