import { describe, expect, it } from 'vitest'
import { computeSpreadsheetTextOverflowWidth } from './spreadsheet-text-overflow'

function width(
  row: string[],
  columnIndex: number,
  {
    merged = [] as number[],
    widths = [80, 80, 80, 80, 80],
    alignment,
    throughColumnIndex
  }: {
    merged?: number[]
    widths?: number[]
    alignment?: 'left' | 'right' | 'center'
    throughColumnIndex?: number
  } = {}
): number | null {
  return computeSpreadsheetTextOverflowWidth({
    row,
    columnIndex,
    columnCount: widths.length,
    columnWidths: widths,
    isMerged: (index) => merged.includes(index),
    alignment,
    throughColumnIndex
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

describe('computeSpreadsheetTextOverflowWidth alignment', () => {
  it('spills rightwards when no alignment is given', () => {
    expect(width(['', 'Presupuesto mensual', '', '', ''], 1)).toBe(320)
  })

  it('spills only rightwards when aligned left', () => {
    expect(width(['', 'Presupuesto mensual', '', '', ''], 1, { alignment: 'left' })).toBe(320)
  })

  it('spills only leftwards when aligned right', () => {
    expect(width(['', '', '', 'SALDO INICIAL', ''], 3, { alignment: 'right' })).toBe(320)
  })

  it('reports no overflow when aligned right and the previous column is occupied', () => {
    expect(width(['', '', 'Previsto', 'SALDO INICIAL', ''], 3, { alignment: 'right' })).toBeNull()
  })

  it('reports no overflow when aligned right on the first column', () => {
    expect(width(['SALDO INICIAL', '', '', '', ''], 0, { alignment: 'right' })).toBeNull()
  })

  it('adds both sides when centred', () => {
    expect(width(['', '', 'Resumen anual', '', ''], 2, { alignment: 'center' })).toBe(400)
  })

  it('adds only the free side when centred beside an occupied column', () => {
    expect(width(['Gastos', '', 'Resumen anual', '', ''], 2, { alignment: 'center' })).toBe(320)
  })

  it('reports no overflow when centred between two occupied columns', () => {
    expect(
      width(['', 'Gastos', 'Resumen anual', 'Previsto', ''], 2, { alignment: 'center' })
    ).toBeNull()
  })

  it('stops the leftward reach at a column that holds something', () => {
    expect(width(['', '', 'Previsto', '', 'Total'], 4, { alignment: 'right' })).toBe(160)
  })

  it('stops the leftward reach at a merged column', () => {
    expect(width(['', '', '', '', 'Total'], 4, { alignment: 'right', merged: [2] })).toBe(160)
  })

  it('bounds each direction separately when centred', () => {
    const emptyRow = Array.from({ length: 40 }, () => '')
    emptyRow[20] = 'Título'

    expect(
      computeSpreadsheetTextOverflowWidth({
        row: emptyRow,
        columnIndex: 20,
        columnCount: 40,
        columnWidths: Array.from({ length: 40 }, () => 100),
        isMerged: () => false,
        alignment: 'center'
      })
    ).toBe(2500)
  })

  it('runs over merely filled neighbours in both directions', () => {
    expect(width(['', '', 'Ganancias', '', ''], 2, { alignment: 'center' })).toBe(400)
    expect(width(['', '', '', '', 'Ganancias'], 4, { alignment: 'right' })).toBe(400)
  })
})

describe('computeSpreadsheetTextOverflowWidth throughColumnIndex', () => {
  it('behaves as if absent when it equals the starting column', () => {
    expect(width(['Título', '', '', '', ''], 0, { throughColumnIndex: 0 })).toBe(400)
  })

  it('counts every column the text already covers as its own width', () => {
    expect(
      width(['Título', '', '', '', ''], 0, {
        throughColumnIndex: 2,
        widths: [50, 120, 30, 80, 80]
      })
    ).toBe(360)
  })

  it('starts the rightward reach past the last covered column', () => {
    expect(width(['Título', '', 'oculto', '', ''], 0, { throughColumnIndex: 2 })).toBe(400)
  })

  it('starts the leftward reach at the starting column when aligned right', () => {
    expect(width(['', '', 'Total', '', ''], 2, { alignment: 'right', throughColumnIndex: 3 })).toBe(
      320
    )
  })

  it('reports no overflow when the covered range leaves no free neighbour', () => {
    expect(width(['Título', '', '', '', ''], 0, { throughColumnIndex: 4 })).toBeNull()
    expect(width(['Título', '', '', 'Previsto', ''], 0, { throughColumnIndex: 2 })).toBeNull()
  })

  it('falls back to the starting column when it points before it', () => {
    expect(width(['', '', 'Título', '', ''], 2, { throughColumnIndex: 0 })).toBe(240)
  })
})
