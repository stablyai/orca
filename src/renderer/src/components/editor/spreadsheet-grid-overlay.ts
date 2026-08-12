import type { ResolvedXlsxSparkline } from './xlsx-sparkline'
import type { XlsxSheetDrawing } from './xlsx-drawings'
import type { XlsxMergedRange } from './xlsx-worksheet-layout'
import type { SpreadsheetMergeIndex } from './spreadsheet-merged-cells'
import type { SpreadsheetCellStyle } from './SpreadsheetCell'

export type SpreadsheetOverlayRect = {
  left: number
  top: number
  width: number
  height: number
}

type XlsxDrawingRange = {
  fromRow: number
  fromColumn: number
  toRow: number
  toColumn: number
}

type SpreadsheetDrawingPlacement = SpreadsheetOverlayRect & { drawing: XlsxSheetDrawing }
type SpreadsheetSparklinePlacement = SpreadsheetOverlayRect & {
  sparkline: ResolvedXlsxSparkline
}

/** The value of a merge that spans rows, drawn over the band the merge paints. */
export type SpreadsheetMergedTextPlacement = SpreadsheetOverlayRect & {
  rowIndex: number
  columnIndex: number
  text: string
  style: SpreadsheetCellStyle | undefined
}

export type SpreadsheetOverlayPlacements = {
  drawings: SpreadsheetDrawingPlacement[]
  sparklines: SpreadsheetSparklinePlacement[]
  mergedTexts: SpreadsheetMergedTextPlacement[]
}

export const EMPTY_SPREADSHEET_OVERLAY: SpreadsheetOverlayPlacements = {
  drawings: [],
  sparklines: [],
  mergedTexts: []
}

/**
 * Maps a cell range to its pixel rectangle inside the scrolled grid.
 *
 * Why an overlay and not the cells themselves: a drawing spans a range, and so
 * does a sparkline sitting in a merged cell. Rows are virtualized one at a time,
 * so anything taller than a row has to be positioned over the grid rather than
 * inside it — drawing it per covered row would repeat it.
 */
export function buildSpreadsheetRectMap({
  columnWidths,
  rowCount,
  getRowHeight,
  rowNumberColumnPx
}: {
  columnWidths: readonly number[]
  rowCount: number
  getRowHeight: (index: number) => number
  rowNumberColumnPx: number
}): (from: XlsxDrawingRange) => SpreadsheetOverlayRect {
  const columnOffsets = buildOffsets(columnWidths.length, (index) => columnWidths[index] ?? 0)
  const rowOffsets = buildOffsets(rowCount, getRowHeight)
  const offsetAt = (offsets: number[], index: number): number =>
    offsets[Math.min(Math.max(index, 0), offsets.length - 1)] ?? 0

  return ({ fromRow, fromColumn, toRow, toColumn }) => {
    const left = rowNumberColumnPx + offsetAt(columnOffsets, fromColumn)
    const top = offsetAt(rowOffsets, fromRow)
    return {
      left,
      top,
      // Why: the end cell is inclusive, so the rectangle runs to the start of the
      // track after it; a minimum keeps a single-cell range visible.
      width: Math.max(1, rowNumberColumnPx + offsetAt(columnOffsets, toColumn + 1) - left),
      height: Math.max(1, offsetAt(rowOffsets, toRow + 1) - top)
    }
  }
}

/** Prefix sums, so `offsets[i]` is where track `i` starts. */
function buildOffsets(count: number, getSize: (index: number) => number): number[] {
  const offsets = Array.from<number>({ length: count + 1 })
  offsets[0] = 0
  for (let index = 0; index < count; index += 1) {
    offsets[index + 1] = offsets[index]! + getSize(index)
  }
  return offsets
}

/**
 * Positions everything that floats over the grid.
 *
 * A sparkline inside a merged cell belongs to the whole merge, which is the block
 * its author sized for it — drawing it per covered row would repeat it, since the
 * merge band is painted one row at a time.
 */
export function buildSpreadsheetOverlayPlacements({
  drawings,
  sparklines,
  mergedRanges,
  rows,
  cellStyles,
  mergeIndex,
  columnWidths,
  rowCount,
  getRowHeight,
  rowNumberColumnPx
}: {
  drawings: readonly XlsxSheetDrawing[] | undefined
  sparklines: readonly (readonly (ResolvedXlsxSparkline | undefined)[] | undefined)[] | undefined
  mergedRanges?: readonly XlsxMergedRange[]
  rows?: readonly (readonly string[])[]
  cellStyles?: readonly (readonly (SpreadsheetCellStyle | undefined)[])[]
  mergeIndex: SpreadsheetMergeIndex
  columnWidths: readonly number[]
  rowCount: number
  getRowHeight: (index: number) => number
  rowNumberColumnPx: number
}): SpreadsheetOverlayPlacements {
  const hasDrawings = drawings !== undefined && drawings.length > 0
  const hasSparklines = sparklines !== undefined && sparklines.length > 0
  // Why: only a merge that spans rows needs the overlay. One confined to a single
  // row is drawn by its own cell, which already spans the columns.
  const tallMerges = (mergedRanges ?? []).filter((merge) => merge.rowSpan > 1)
  if (!hasDrawings && !hasSparklines && tallMerges.length === 0) {
    return EMPTY_SPREADSHEET_OVERLAY
  }

  const rectFor = buildSpreadsheetRectMap({
    columnWidths,
    rowCount,
    getRowHeight,
    rowNumberColumnPx
  })
  const drawingPlacements = (drawings ?? []).map((drawing) => ({
    drawing,
    ...rectFor(drawing)
  }))
  const sparklinePlacements: SpreadsheetSparklinePlacement[] = []
  for (const [rowIndex, row] of (sparklines ?? []).entries()) {
    for (const [columnIndex, sparkline] of (row ?? []).entries()) {
      if (sparkline === undefined) {
        continue
      }
      const merge = mergeIndex.find(rowIndex, columnIndex)
      sparklinePlacements.push({
        sparkline,
        ...rectFor(merge === undefined ? singleCell(rowIndex, columnIndex) : mergeRange(merge))
      })
    }
  }

  const mergedTexts: SpreadsheetMergedTextPlacement[] = []
  for (const merge of tallMerges) {
    const text = rows?.[merge.rowIndex]?.[merge.columnIndex] ?? ''
    if (text === '') {
      continue
    }
    mergedTexts.push({
      rowIndex: merge.rowIndex,
      columnIndex: merge.columnIndex,
      text,
      style: cellStyles?.[merge.rowIndex]?.[merge.columnIndex],
      ...rectFor(mergeRange(merge))
    })
  }

  return { drawings: drawingPlacements, sparklines: sparklinePlacements, mergedTexts }
}

function singleCell(rowIndex: number, columnIndex: number): XlsxDrawingRange {
  return { fromRow: rowIndex, fromColumn: columnIndex, toRow: rowIndex, toColumn: columnIndex }
}

function mergeRange(merge: XlsxMergedRange): XlsxDrawingRange {
  return {
    fromRow: merge.rowIndex,
    fromColumn: merge.columnIndex,
    toRow: merge.rowIndex + merge.rowSpan - 1,
    toColumn: merge.columnIndex + merge.columnSpan - 1
  }
}
