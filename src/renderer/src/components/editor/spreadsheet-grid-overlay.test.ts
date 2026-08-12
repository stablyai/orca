import { describe, expect, it } from 'vitest'
import {
  buildSpreadsheetOverlayPlacements,
  type SpreadsheetMergedTextPlacement
} from './spreadsheet-grid-overlay'
import { buildSpreadsheetMergeIndex } from './spreadsheet-merged-cells'
import type { SpreadsheetCellStyle } from './SpreadsheetCell'
import type { XlsxMergedRange } from './xlsx-worksheet-layout'

const COLUMN_COUNT = 10
const COLUMN_WIDTH_PX = 86
const ROW_NUMBER_COLUMN_PX = 49
const ROW_HEIGHT_PX = 20
const ROW_COUNT = 20
const COLUMN_WIDTHS = Array.from({ length: COLUMN_COUNT }, () => COLUMN_WIDTH_PX)

function rowWith(values: Record<number, string>): string[] {
  const row = Array.from({ length: COLUMN_COUNT }, () => '')
  for (const [columnIndex, value] of Object.entries(values)) {
    row[Number(columnIndex)] = value
  }
  return row
}

function stylesAt(
  rowIndex: number,
  columnIndex: number,
  style: SpreadsheetCellStyle
): (SpreadsheetCellStyle | undefined)[][] {
  const sheet = Array.from({ length: ROW_COUNT }, () => [] as (SpreadsheetCellStyle | undefined)[])
  sheet[rowIndex]![columnIndex] = style
  return sheet
}

function mergedTexts({
  rows = [],
  cellStyles,
  mergedRanges
}: {
  rows?: readonly (readonly string[])[]
  cellStyles?: readonly (readonly (SpreadsheetCellStyle | undefined)[])[]
  mergedRanges: readonly XlsxMergedRange[]
}): SpreadsheetMergedTextPlacement[] {
  return buildSpreadsheetOverlayPlacements({
    drawings: undefined,
    sparklines: undefined,
    mergedRanges,
    rows,
    cellStyles,
    mergeIndex: buildSpreadsheetMergeIndex(mergedRanges),
    columnWidths: COLUMN_WIDTHS,
    rowCount: ROW_COUNT,
    getRowHeight: () => ROW_HEIGHT_PX,
    rowNumberColumnPx: ROW_NUMBER_COLUMN_PX
  }).mergedTexts
}

function leftOfColumn(columnIndex: number): number {
  return ROW_NUMBER_COLUMN_PX + columnIndex * COLUMN_WIDTH_PX
}

describe('buildSpreadsheetOverlayPlacements merged text overflow', () => {
  it('keeps the merge rectangle when both sides are occupied', () => {
    const merge: XlsxMergedRange = { rowIndex: 1, columnIndex: 1, rowSpan: 2, columnSpan: 2 }

    const [placement] = mergedTexts({
      rows: [[], rowWith({ 0: 'Gastos', 1: 'Presupuesto', 3: 'Previsto' })],
      mergedRanges: [merge]
    })

    expect(placement?.left).toBe(leftOfColumn(1))
    expect(placement?.width).toBe(2 * COLUMN_WIDTH_PX)
  })

  it('grows rightwards without moving when aligned left', () => {
    const merge: XlsxMergedRange = { rowIndex: 1, columnIndex: 1, rowSpan: 2, columnSpan: 2 }

    const [placement] = mergedTexts({
      rows: [[], rowWith({ 0: 'Gastos', 1: 'Presupuesto mensual consolidado' })],
      cellStyles: stylesAt(1, 1, { horizontalAlignment: 'left' }),
      mergedRanges: [merge]
    })

    expect(placement?.left).toBe(leftOfColumn(1))
    expect(placement?.width).toBe(9 * COLUMN_WIDTH_PX)
  })

  it('grows leftwards keeping its right edge when aligned right', () => {
    const merge: XlsxMergedRange = { rowIndex: 1, columnIndex: 5, rowSpan: 2, columnSpan: 2 }
    const rectLeft = leftOfColumn(5)
    const rectWidth = 2 * COLUMN_WIDTH_PX

    const [placement] = mergedTexts({
      rows: [[], rowWith({ 5: 'SALDO INICIAL ', 7: ' SALDO FINAL' })],
      cellStyles: stylesAt(1, 5, { horizontalAlignment: 'right' }),
      mergedRanges: [merge]
    })

    expect(placement?.left).toBeLessThan(rectLeft)
    expect(placement?.width).toBe(7 * COLUMN_WIDTH_PX)
    expect(placement!.left + placement!.width).toBe(rectLeft + rectWidth)
  })

  it('stays centred on the merge when aligned centre', () => {
    const merge: XlsxMergedRange = { rowIndex: 1, columnIndex: 4, rowSpan: 2, columnSpan: 2 }
    const rectLeft = leftOfColumn(4)
    const rectWidth = 2 * COLUMN_WIDTH_PX

    const [placement] = mergedTexts({
      rows: [[], rowWith({ 0: 'Gastos', 4: 'Resumen anual' })],
      cellStyles: stylesAt(1, 4, { horizontalAlignment: 'center' }),
      mergedRanges: [merge]
    })

    expect(placement?.left).toBeLessThan(rectLeft)
    expect(placement?.width).toBe(9 * COLUMN_WIDTH_PX)
    expect(placement!.left + placement!.width / 2).toBe(rectLeft + rectWidth / 2)
  })

  it('does not spill wrapped text', () => {
    const merge: XlsxMergedRange = { rowIndex: 1, columnIndex: 1, rowSpan: 2, columnSpan: 2 }

    const [placement] = mergedTexts({
      rows: [[], rowWith({ 1: 'Presupuesto mensual consolidado' })],
      cellStyles: stylesAt(1, 1, { wrapText: true }),
      mergedRanges: [merge]
    })

    expect(placement?.left).toBe(leftOfColumn(1))
    expect(placement?.width).toBe(2 * COLUMN_WIDTH_PX)
  })

  it('does not let a merge clip itself with its own covered columns', () => {
    const merge: XlsxMergedRange = { rowIndex: 1, columnIndex: 1, rowSpan: 2, columnSpan: 3 }

    const [placement] = mergedTexts({
      rows: [[], rowWith({ 1: 'Presupuesto mensual consolidado' })],
      mergedRanges: [merge]
    })

    expect(placement?.width).toBe(9 * COLUMN_WIDTH_PX)
  })

  it('stops at another merge beside it', () => {
    const title: XlsxMergedRange = { rowIndex: 1, columnIndex: 1, rowSpan: 2, columnSpan: 2 }
    const neighbour: XlsxMergedRange = { rowIndex: 1, columnIndex: 3, rowSpan: 2, columnSpan: 2 }

    const [placement] = mergedTexts({
      rows: [[], rowWith({ 1: 'Presupuesto mensual consolidado' })],
      mergedRanges: [title, neighbour]
    })

    expect(placement?.width).toBe(2 * COLUMN_WIDTH_PX)
  })

  it('produces no entry for a merge without text', () => {
    expect(
      mergedTexts({
        rows: [[], rowWith({})],
        mergedRanges: [{ rowIndex: 1, columnIndex: 1, rowSpan: 2, columnSpan: 2 }]
      })
    ).toEqual([])
  })

  it('produces entries only for merges that span rows', () => {
    const placements = mergedTexts({
      rows: [[], rowWith({ 1: 'Una fila' }), rowWith({ 1: 'Dos filas' })],
      mergedRanges: [
        { rowIndex: 1, columnIndex: 1, rowSpan: 1, columnSpan: 2 },
        { rowIndex: 2, columnIndex: 1, rowSpan: 2, columnSpan: 2 }
      ]
    })

    expect(placements).toHaveLength(1)
    expect(placements[0]?.rowIndex).toBe(2)
  })
})
