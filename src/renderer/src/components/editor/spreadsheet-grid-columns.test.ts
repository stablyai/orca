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
})

describe('buildSpreadsheetGridTemplate', () => {
  it('puts the row-number column first', () => {
    expect(buildSpreadsheetGridTemplate([80, 120])).toBe(
      `${SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX}px 80px 120px`
    )
  })

  it('still emits the row-number column for an empty sheet', () => {
    expect(buildSpreadsheetGridTemplate([])).toBe(`${SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX}px `)
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
