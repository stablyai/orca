import { describe, expect, it } from 'vitest'
import {
  SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX,
  buildSpreadsheetGridTemplate,
  computeSpreadsheetColumnWidths,
  padSpreadsheetHeader
} from './spreadsheet-grid-columns'

describe('computeSpreadsheetColumnWidths', () => {
  it('gives every column the minimum width when values are short', () => {
    const widths = computeSpreadsheetColumnWidths({
      header: ['a', 'b'],
      rows: [['1', '2']],
      columnCount: 2
    })

    expect(widths).toEqual([80, 80])
  })

  it('sizes a column to its widest value, header included', () => {
    const widths = computeSpreadsheetColumnWidths({
      header: ['short', 'a header long enough to grow'],
      rows: [['a value long enough to grow', 'x']],
      columnCount: 2
    })

    expect(widths[0]).toBeGreaterThan(80)
    expect(widths[1]).toBeGreaterThan(80)
  })

  it('caps a runaway value at the maximum width', () => {
    const widths = computeSpreadsheetColumnWidths({
      header: [],
      rows: [['x'.repeat(5000)]],
      columnCount: 1
    })

    expect(widths).toEqual([320])
  })

  it('only samples the first 200 rows', () => {
    const rows = Array.from({ length: 250 }, (_, index) =>
      index === 249 ? ['x'.repeat(200)] : ['x']
    )

    expect(computeSpreadsheetColumnWidths({ header: [], rows, columnCount: 1 })).toEqual([80])
  })

  it('ignores cells beyond the declared column count', () => {
    const widths = computeSpreadsheetColumnWidths({
      header: ['a', 'x'.repeat(200)],
      rows: [['a', 'x'.repeat(200)]],
      columnCount: 1
    })

    expect(widths).toEqual([80])
  })

  it('tolerates ragged rows and an empty sheet', () => {
    expect(
      computeSpreadsheetColumnWidths({ header: ['a'], rows: [[], ['b']], columnCount: 2 })
    ).toEqual([80, 80])
    expect(computeSpreadsheetColumnWidths({ header: [], rows: [], columnCount: 0 })).toEqual([])
  })

  it("prefers a reader's width over the declared one and over sizing from content", () => {
    const widths = computeSpreadsheetColumnWidths({
      header: ['a header long enough to grow'],
      rows: [['a value long enough to grow']],
      columnCount: 1,
      declaredColumnWidths: [200],
      columnWidthOverrides: [130]
    })

    expect(widths).toEqual([130])
  })

  it("scales a reader's width by the zoom level like any other width", () => {
    const widths = computeSpreadsheetColumnWidths({
      header: ['a'],
      rows: [['1']],
      columnCount: 1,
      columnWidthOverrides: [130],
      zoomScale: 1.5
    })

    expect(widths).toEqual([195])
  })

  it('falls back per column when a reader has only sized some of them', () => {
    const widths = computeSpreadsheetColumnWidths({
      header: ['a', 'b', 'c'],
      rows: [['1', '2', '3']],
      columnCount: 3,
      declaredColumnWidths: [undefined, 200, undefined],
      columnWidthOverrides: [130, undefined, undefined]
    })

    expect(widths).toEqual([130, 200, 80])
  })

  it('sizes exactly as before when the reader has sized nothing', () => {
    const input = {
      header: ['a header long enough to grow', 'b'],
      rows: [['1', '2']],
      columnCount: 2,
      declaredColumnWidths: [undefined, 200]
    }

    expect(computeSpreadsheetColumnWidths({ ...input, columnWidthOverrides: [] })).toEqual(
      computeSpreadsheetColumnWidths(input)
    )
  })

  it("honours a reader's width of zero instead of falling back to the declared one", () => {
    const widths = computeSpreadsheetColumnWidths({
      header: ['a'],
      rows: [['1']],
      columnCount: 1,
      declaredColumnWidths: [200],
      columnWidthOverrides: [0]
    })

    expect(widths).toEqual([0])
  })
})

describe('buildSpreadsheetGridTemplate', () => {
  it('puts the row-number column first and a spacer track on each side', () => {
    expect(buildSpreadsheetGridTemplate({ columnWidths: [80, 120] })).toBe(
      `${SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX}px 0px 80px 120px 0px`
    )
  })

  it('sizes the spacers to the columns scrolled out of view on each side', () => {
    // Why: the spacers stand in for the virtualized columns, so the rendered ones
    // stay under their own headings while scrolled.
    expect(
      buildSpreadsheetGridTemplate({
        columnWidths: [100],
        leadingSpacerPx: 240,
        trailingSpacerPx: 560
      })
    ).toBe(`${SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX}px 240px 100px 560px`)
  })

  it('still emits the row-number column for an empty sheet', () => {
    expect(buildSpreadsheetGridTemplate({ columnWidths: [] })).toBe(
      `${SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX}px 0px 0px`
    )
  })
})

describe('padSpreadsheetHeader', () => {
  it('pads a short header out to the column count', () => {
    expect(padSpreadsheetHeader(['a'], 3)).toEqual(['a', '', ''])
  })

  it('trims a header wider than the column count', () => {
    expect(padSpreadsheetHeader(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })

  it('leaves an exact header untouched', () => {
    expect(padSpreadsheetHeader(['a', 'b'], 2)).toEqual(['a', 'b'])
  })
})
