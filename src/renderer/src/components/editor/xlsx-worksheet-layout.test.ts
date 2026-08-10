import { describe, expect, it } from 'vitest'
import { parseMergeReference, parseXlsxWorksheetLayout } from './xlsx-worksheet-layout'

describe('parseXlsxWorksheetLayout column widths', () => {
  it('converts a declared width from character units to pixels', () => {
    const layout = parseXlsxWorksheetLayout(
      '<worksheet><cols><col min="2" max="2" width="30" customWidth="1"/></cols></worksheet>'
    )

    expect(layout.columnWidths[1]).toBe(215)
    expect(layout.columnWidths[0]).toBeUndefined()
  })

  it('applies a width across the whole min..max span', () => {
    const layout = parseXlsxWorksheetLayout(
      '<worksheet><cols><col min="3" max="5" width="10" customWidth="1"/></cols></worksheet>'
    )

    expect(layout.columnWidths[2]).toBe(75)
    expect(layout.columnWidths[3]).toBe(75)
    expect(layout.columnWidths[4]).toBe(75)
    expect(layout.columnWidths[5]).toBeUndefined()
  })

  it('ignores a col that is not a custom width', () => {
    // Why: Excel writes <col> for a style span or an outline level too. Adopting
    // the default width it repeats there would override content-based sizing with
    // a value the author never chose.
    const layout = parseXlsxWorksheetLayout(
      '<worksheet><cols><col min="1" max="16384" width="8.7109375" style="2"/></cols></worksheet>'
    )

    expect(layout.columnWidths.filter((width) => width !== undefined)).toEqual([])
  })

  it('clamps a zero or absurd declared width', () => {
    const layout = parseXlsxWorksheetLayout(
      '<worksheet><cols><col min="1" max="1" width="0" customWidth="1"/><col min="2" max="2" width="99999" customWidth="1"/></cols></worksheet>'
    )

    expect(layout.columnWidths[0]).toBe(16)
    expect(layout.columnWidths[1]).toBe(2000)
  })

  it('ignores a col with no usable width or range', () => {
    const layout = parseXlsxWorksheetLayout(
      '<worksheet><cols><col customWidth="1"/><col min="0" max="2" width="10" customWidth="1"/></cols></worksheet>'
    )

    expect(layout.columnWidths.filter((width) => width !== undefined)).toEqual([])
  })
})

describe('parseXlsxWorksheetLayout merged ranges', () => {
  it('reads each merged range as an anchor plus a span', () => {
    const layout = parseXlsxWorksheetLayout(
      '<worksheet><mergeCells count="2"><mergeCell ref="B2:G5"/><mergeCell ref="A1:A1"/></mergeCells></worksheet>'
    )

    expect(layout.mergedRanges).toEqual([
      { rowIndex: 1, columnIndex: 1, rowSpan: 4, columnSpan: 6 },
      { rowIndex: 0, columnIndex: 0, rowSpan: 1, columnSpan: 1 }
    ])
  })

  it('returns nothing for a sheet with no merges', () => {
    expect(parseXlsxWorksheetLayout('<worksheet/>').mergedRanges).toEqual([])
    expect(parseXlsxWorksheetLayout('').mergedRanges).toEqual([])
  })
})

describe('parseMergeReference', () => {
  it('normalizes a reversed range to its top-left anchor', () => {
    expect(parseMergeReference('G5:B2')).toEqual({
      rowIndex: 1,
      columnIndex: 1,
      rowSpan: 4,
      columnSpan: 6
    })
  })

  it('rejects a reference that is not a range', () => {
    expect(parseMergeReference(undefined)).toBeNull()
    expect(parseMergeReference('B2')).toBeNull()
    expect(parseMergeReference('B2:')).toBeNull()
    expect(parseMergeReference('nonsense:B2')).toBeNull()
  })
})
