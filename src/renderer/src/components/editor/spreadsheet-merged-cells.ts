import type { XlsxMergedRange } from './xlsx-worksheet-layout'

export type SpreadsheetMergeIndex = {
  /** The merge covering a cell, or undefined when it stands alone. */
  find(rowIndex: number, columnIndex: number): XlsxMergedRange | undefined
  /** True when at least one merge was dropped to stay within the slot budget. */
  truncated: boolean
}

export const EMPTY_SPREADSHEET_MERGE_INDEX: SpreadsheetMergeIndex = {
  find: () => undefined,
  truncated: false
}

// Why: the index is bucketed per row for O(1) lookup while rendering, so its size
// follows the rows a merge covers, not its cell count. A single merge may legally
// span a whole column, so the total number of buckets is capped rather than
// trusted; past the budget the remaining merges are dropped and reported.
const MAX_MERGE_ROW_SLOTS = 200_000

/**
 * Indexes merged ranges for lookup while rendering.
 *
 * A merge is rendered as a band: every row it covers gets one cell spanning its
 * columns, and only the anchor row carries the text. Rows are virtualized
 * independently of each other, so a real row span is not available — this keeps
 * the merge looking continuous without giving that up.
 */
export function buildSpreadsheetMergeIndex(
  mergedRanges: readonly XlsxMergedRange[]
): SpreadsheetMergeIndex {
  if (mergedRanges.length === 0) {
    return EMPTY_SPREADSHEET_MERGE_INDEX
  }

  const mergesByRow = new Map<number, XlsxMergedRange[]>()
  let rowSlots = 0
  let truncated = false

  for (const range of mergedRanges) {
    if (rowSlots + range.rowSpan > MAX_MERGE_ROW_SLOTS) {
      truncated = true
      continue
    }
    for (let offset = 0; offset < range.rowSpan; offset += 1) {
      const rowIndex = range.rowIndex + offset
      const rowMerges = mergesByRow.get(rowIndex)
      if (rowMerges === undefined) {
        mergesByRow.set(rowIndex, [range])
      } else {
        rowMerges.push(range)
      }
      rowSlots += 1
    }
  }

  return {
    find: (rowIndex, columnIndex) =>
      mergesByRow
        .get(rowIndex)
        ?.find(
          (range) =>
            columnIndex >= range.columnIndex && columnIndex < range.columnIndex + range.columnSpan
        ),
    truncated
  }
}

/**
 * Total height of the rows a merge covers.
 *
 * The cell that owns a merge's value is given this height so its text can use
 * the whole band. Without it a large value — a title merged down two rows — is
 * clipped to the first row, which is not where the author put it.
 */
export function sumSpreadsheetRowHeights(
  merge: XlsxMergedRange,
  getRowHeight: (rowIndex: number) => number
): number {
  let height = 0
  for (let offset = 0; offset < merge.rowSpan; offset += 1) {
    height += getRowHeight(merge.rowIndex + offset)
  }
  return height
}

/**
 * True when a row owns the value of a merge that reaches into the rows below it.
 *
 * Such a row is painted above its neighbours, because a virtualized row carries a
 * `transform` and is therefore its own stacking context — a z-index on the cell
 * inside cannot rise above the next row, so the lift has to happen on the row.
 */
export function anchorsVerticalMerge(
  mergeIndex: SpreadsheetMergeIndex,
  rowIndex: number,
  columnCount: number
): boolean {
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const merge = mergeIndex.find(rowIndex, columnIndex)
    if (merge === undefined) {
      continue
    }
    if (merge.rowSpan > 1 && merge.rowIndex === rowIndex) {
      return true
    }
    // Why: skip to the end of this merge rather than testing every column it
    // covers, so a sheet of wide merges stays cheap to scan.
    columnIndex = merge.columnIndex + merge.columnSpan - 1
  }
  return false
}

export type SpreadsheetMergePlacement = {
  /** Grid tracks this cell occupies, already clamped to the rendered window. */
  columnSpan: number
  /** False for a covered cell, which shows the merge's fill but no value. */
  showsValue: boolean
}

/**
 * Decides how a cell inside a merge is placed, given the columns currently
 * rendered. Returns null when another cell of the same merge already covers it.
 *
 * Why clamp to the window: with columns virtualized, a merge can start or end
 * outside it. The rendered cell has to consume exactly the tracks that exist, or
 * the row's tracks stop lining up with the header's.
 */
export function planSpreadsheetMergePlacement({
  merge,
  rowIndex,
  columnIndex,
  firstRenderedColumn,
  lastRenderedColumn
}: {
  merge: XlsxMergedRange
  rowIndex: number
  columnIndex: number
  firstRenderedColumn: number
  lastRenderedColumn: number
}): SpreadsheetMergePlacement | null {
  const spanStart = Math.max(merge.columnIndex, firstRenderedColumn)
  if (columnIndex !== spanStart) {
    return null
  }
  const spanEnd = Math.min(merge.columnIndex + merge.columnSpan - 1, lastRenderedColumn)
  return {
    columnSpan: Math.max(1, spanEnd - spanStart + 1),
    // Why: the value belongs to the anchor. When the anchor's column is scrolled
    // out of view the band still renders, just without repeating the text in a
    // cell that does not own it.
    showsValue: rowIndex === merge.rowIndex && columnIndex === merge.columnIndex
  }
}
