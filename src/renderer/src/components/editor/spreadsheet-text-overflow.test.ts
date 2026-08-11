import { describe, expect, it } from 'vitest'
import { computeSpreadsheetTextOverflowWidth } from './spreadsheet-text-overflow'

function width(
  row: string[],
  columnIndex: number,
  { merged = [] as number[], widths = [80, 80, 80, 80, 80] } = {}
): number | null {
  return computeSpreadsheetTextOverflowWidth({
    row,
    columnIndex,
    columnCount: widths.length,
    columnWidths: widths,
    isMerged: (index) => merged.includes(index)
  })
}

describe('computeSpreadsheetTextOverflowWidth', () => {
  it('runs across every following empty column', () => {
    // Why: this is what turns "Presupuesto mens…" back into the whole title.
    expect(width(['Presupuesto mensual', '', '', '', ''], 0)).toBe(400)
  })

  it('stops at the first column that holds something', () => {
    expect(width(['Gastos', '', 'Previsto', '', ''], 0)).toBe(160)
  })

  it('stops at a merged column, whose value lives in the merge anchor', () => {
    // Why: a merge owns its cell even when this row reads empty, so the label
    // would run over another cell's text.
    expect(width(['Gastos', '', '', '', ''], 0, { merged: [2] })).toBe(160)
  })

  it('runs over a neighbour that is merely filled, as a spreadsheet does', () => {
    // Why: a heading beside a banded but empty range was being clipped; Excel
    // paints the label straight over the colour.
    expect(width(['Ganancias', '', '', '', ''], 0)).toBe(400)
  })

  it('reports no overflow when the very next column belongs to a merge', () => {
    expect(width(['Gastos', '', '', '', ''], 0, { merged: [1] })).toBeNull()
  })

  it('stops at the first of several merged columns in a row', () => {
    expect(width(['Gastos', '', '', '', ''], 0, { merged: [2, 3, 4] })).toBe(160)
  })

  it('runs to the reach limit when the merge sits just past it', () => {
    const emptyRow = Array.from({ length: 40 }, () => '')
    emptyRow[0] = 'Título'

    expect(
      computeSpreadsheetTextOverflowWidth({
        row: emptyRow,
        columnIndex: 0,
        columnCount: 40,
        columnWidths: Array.from({ length: 40 }, () => 100),
        isMerged: (index) => index === 13
      })
    ).toBe(1300)
  })

  it('stops one column short when the merge sits on the last column in reach', () => {
    const emptyRow = Array.from({ length: 40 }, () => '')
    emptyRow[0] = 'Título'

    expect(
      computeSpreadsheetTextOverflowWidth({
        row: emptyRow,
        columnIndex: 0,
        columnCount: 40,
        columnWidths: Array.from({ length: 40 }, () => 100),
        isMerged: (index) => index === 12
      })
    ).toBe(1200)
  })

  it('reports no overflow when the next column is occupied', () => {
    // Why: null keeps the cell clipped rather than opting it into an overflow it
    // does not use, which would leave a misleading overflow-visible on the box.
    expect(width(['Real', '1.000 €', '', '', ''], 0)).toBeNull()
  })

  it('adds each column its own width', () => {
    expect(width(['Título', '', ''], 0, { widths: [50, 120, 30] })).toBe(200)
  })

  it('does not run past the last column', () => {
    expect(width(['', '', '', '', 'Final'], 4)).toBeNull()
  })

  it('bounds the reach so a sparse sheet cannot force a scrollbar', () => {
    const emptyRow = Array.from({ length: 40 }, () => '')
    emptyRow[0] = 'Título'
    const widths = Array.from({ length: 40 }, () => 100)

    expect(
      computeSpreadsheetTextOverflowWidth({
        row: emptyRow,
        columnIndex: 0,
        columnCount: 40,
        columnWidths: widths,
        isMerged: () => false
      })
    ).toBe(1300)
  })
})
