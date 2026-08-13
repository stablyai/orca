import { describe, expect, it } from 'vitest'
import {
  buildSpreadsheetOverlayPlacements,
  buildSpreadsheetRectMap,
  type SpreadsheetMergedTextPlacement,
  type SpreadsheetOverlayPlacements
} from './spreadsheet-grid-overlay'
import { buildSpreadsheetMergeIndex } from './spreadsheet-merged-cells'
import type { SpreadsheetCellStyle } from './SpreadsheetCell'
import type { ResolvedXlsxSparkline } from './xlsx-sparkline'
import type { XlsxSheetDrawing } from './xlsx-drawings'
import type { XlsxMergedRange } from './xlsx-worksheet-layout'

const COLUMN_COUNT = 10
const COLUMN_WIDTH_PX = 86
const ROW_NUMBER_COLUMN_PX = 49
const ROW_HEIGHT_PX = 20
const ROW_COUNT = 20
const HEADER_ROW_HEIGHT_PX = 28
const COLUMN_WIDTHS = Array.from({ length: COLUMN_COUNT }, () => COLUMN_WIDTH_PX)
const VARIED_ROW_HEIGHTS = [18, 24, 30, 20, 40, 22]

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

function rectMap(
  headerRowHeightPx?: number,
  getRowHeight: (index: number) => number = () => ROW_HEIGHT_PX
): (from: { fromRow: number; fromColumn: number; toRow: number; toColumn: number }) => {
  left: number
  top: number
  width: number
  height: number
} {
  return buildSpreadsheetRectMap({
    columnWidths: COLUMN_WIDTHS,
    rowCount: ROW_COUNT,
    getRowHeight,
    rowNumberColumnPx: ROW_NUMBER_COLUMN_PX,
    ...(headerRowHeightPx === undefined ? {} : { headerRowHeightPx })
  })
}

const VARIED_ROW_HEIGHT = (index: number): number => VARIED_ROW_HEIGHTS[index] ?? ROW_HEIGHT_PX

const IMAGE_DRAWING: XlsxSheetDrawing = {
  kind: 'image',
  source: 'data:image/png;base64,AAAA',
  fromRow: 2,
  fromColumn: 1,
  toRow: 3,
  toColumn: 2
}

const SPARKLINE: ResolvedXlsxSparkline = {
  chartType: 'line',
  values: [1, 4, 2],
  min: 0,
  max: 4,
  color: '#5b9bd5'
}

function sparklineSheetAt(
  rowIndex: number,
  columnIndex: number
): (ResolvedXlsxSparkline | undefined)[][] {
  const sheet = Array.from({ length: ROW_COUNT }, () => [] as (ResolvedXlsxSparkline | undefined)[])
  sheet[rowIndex]![columnIndex] = SPARKLINE
  return sheet
}

function overlayPlacements(headerRowHeightPx?: number): SpreadsheetOverlayPlacements {
  const mergedRanges: XlsxMergedRange[] = [
    { rowIndex: 1, columnIndex: 1, rowSpan: 2, columnSpan: 2 }
  ]
  return buildSpreadsheetOverlayPlacements({
    drawings: [IMAGE_DRAWING],
    sparklines: sparklineSheetAt(4, 3),
    mergedRanges,
    rows: [[], rowWith({ 0: 'Gastos', 1: 'Presupuesto', 3: 'Previsto' })],
    mergeIndex: buildSpreadsheetMergeIndex(mergedRanges),
    columnWidths: COLUMN_WIDTHS,
    rowCount: ROW_COUNT,
    getRowHeight: () => ROW_HEIGHT_PX,
    rowNumberColumnPx: ROW_NUMBER_COLUMN_PX,
    ...(headerRowHeightPx === undefined ? {} : { headerRowHeightPx })
  })
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

describe('buildSpreadsheetRectMap heading row offset', () => {
  const firstRow = { fromRow: 0, fromColumn: 0, toRow: 0, toColumn: 0 }

  it('starts the first row at the top of the layer when no heading height is given', () => {
    expect(rectMap()(firstRow).top).toBe(0)
  })

  it('pushes the first row below the heading row', () => {
    expect(rectMap(HEADER_ROW_HEIGHT_PX)(firstRow).top).toBe(HEADER_ROW_HEIGHT_PX)
  })

  it('keeps every height unchanged when the heading offset moves the rectangle down', () => {
    const ranges = [
      firstRow,
      { fromRow: 0, fromColumn: 0, toRow: 2, toColumn: 1 },
      { fromRow: 3, fromColumn: 2, toRow: 7, toColumn: 4 }
    ]

    for (const range of ranges) {
      expect(rectMap(HEADER_ROW_HEIGHT_PX)(range).height).toBe(rectMap()(range).height)
    }
  })

  it('leaves the horizontal placement untouched', () => {
    const range = { fromRow: 2, fromColumn: 3, toRow: 4, toColumn: 5 }
    const offset = rectMap(HEADER_ROW_HEIGHT_PX)(range)
    const flush = rectMap()(range)

    expect(offset.left).toBe(flush.left)
    expect(offset.left).toBe(leftOfColumn(3))
    expect(offset.width).toBe(flush.width)
  })

  it('shifts a multi-row range while sizing it to the rows it covers', () => {
    const rect = rectMap(HEADER_ROW_HEIGHT_PX)({
      fromRow: 1,
      fromColumn: 0,
      toRow: 3,
      toColumn: 0
    })

    expect(rect.top).toBe(HEADER_ROW_HEIGHT_PX + ROW_HEIGHT_PX)
    expect(rect.height).toBe(3 * ROW_HEIGHT_PX)
  })

  it('treats an explicit zero heading height as no heading row', () => {
    const range = { fromRow: 2, fromColumn: 1, toRow: 4, toColumn: 3 }

    expect(rectMap(0)(range)).toEqual(rectMap()(range))
  })

  it('shifts a later row by the heading height over rows of differing heights', () => {
    const rect = rectMap(
      HEADER_ROW_HEIGHT_PX,
      VARIED_ROW_HEIGHT
    )({
      fromRow: 5,
      fromColumn: 0,
      toRow: 5,
      toColumn: 0
    })
    const rowsAbove = VARIED_ROW_HEIGHTS.slice(0, 5).reduce((total, height) => total + height, 0)

    expect(rect.top).toBe(HEADER_ROW_HEIGHT_PX + rowsAbove)
    expect(rect.height).toBe(VARIED_ROW_HEIGHTS[5])
  })
})

describe('buildSpreadsheetOverlayPlacements heading row offset', () => {
  it('pushes a merged label down by the heading height', () => {
    const [offset] = overlayPlacements(HEADER_ROW_HEIGHT_PX).mergedTexts
    const [flush] = overlayPlacements().mergedTexts

    expect(flush?.top).toBe(ROW_HEIGHT_PX)
    expect(offset?.top).toBe(ROW_HEIGHT_PX + HEADER_ROW_HEIGHT_PX)
  })

  it('pushes a drawing down by the heading height', () => {
    const [offset] = overlayPlacements(HEADER_ROW_HEIGHT_PX).drawings
    const [flush] = overlayPlacements().drawings

    expect(flush?.top).toBe(2 * ROW_HEIGHT_PX)
    expect(offset?.top).toBe(2 * ROW_HEIGHT_PX + HEADER_ROW_HEIGHT_PX)
    expect(offset?.drawing).toBe(IMAGE_DRAWING)
  })

  it('pushes a sparkline down by the heading height', () => {
    const [offset] = overlayPlacements(HEADER_ROW_HEIGHT_PX).sparklines
    const [flush] = overlayPlacements().sparklines

    expect(flush?.top).toBe(4 * ROW_HEIGHT_PX)
    expect(offset?.top).toBe(4 * ROW_HEIGHT_PX + HEADER_ROW_HEIGHT_PX)
    expect(offset?.sparkline).toBe(SPARKLINE)
  })

  it('keeps every placement the same size with and without the heading offset', () => {
    const offset = overlayPlacements(HEADER_ROW_HEIGHT_PX)
    const flush = overlayPlacements()

    expect(offset.mergedTexts.map((placement) => placement.height)).toEqual(
      flush.mergedTexts.map((placement) => placement.height)
    )
    expect(offset.drawings.map((placement) => placement.height)).toEqual(
      flush.drawings.map((placement) => placement.height)
    )
    expect(offset.sparklines.map((placement) => placement.height)).toEqual(
      flush.sparklines.map((placement) => placement.height)
    )
    expect(offset.mergedTexts[0]?.height).toBe(2 * ROW_HEIGHT_PX)
  })
})
