import { describe, expect, it } from 'vitest'
import { computeSpreadsheetTextOverflowWidth } from './spreadsheet-text-overflow'

function width(
  row: string[],
  columnIndex: number,
  { filled = [] as number[], widths = [80, 80, 80, 80, 80] } = {}
): number | null {
  return computeSpreadsheetTextOverflowWidth({
    row,
    columnIndex,
    columnCount: widths.length,
    columnWidths: widths,
    hasBackground: (index) => filled.includes(index)
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

  it('stops at a column that carries a fill, even when it is empty', () => {
    // Why: a filled cell is visible, so the text would run over a coloured block.
    expect(width(['Gastos', '', '', '', ''], 0, { filled: [2] })).toBe(160)
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
        hasBackground: () => false
      })
    ).toBe(1300)
  })
})
