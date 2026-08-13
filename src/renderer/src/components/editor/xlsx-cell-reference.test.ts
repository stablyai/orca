import { describe, expect, it } from 'vitest'
import {
  columnIndexFromXlsxLetters,
  expandXlsxCellRange,
  expandXlsxCellRangeList,
  parseXlsxCellReference,
  xlsxColumnLettersFromIndex
} from './xlsx-cell-reference'

describe('parseXlsxCellReference', () => {
  it('parses single and multi letter columns', () => {
    expect(parseXlsxCellReference('A1')).toEqual({ columnIndex: 0, rowIndex: 0 })
    expect(parseXlsxCellReference('Z9')).toEqual({ columnIndex: 25, rowIndex: 8 })
    expect(parseXlsxCellReference('AA2')).toEqual({ columnIndex: 26, rowIndex: 1 })
    expect(parseXlsxCellReference('AB12')).toEqual({ columnIndex: 27, rowIndex: 11 })
  })

  it('parses the last cell of the Excel grid', () => {
    expect(parseXlsxCellReference('XFD1048576')).toEqual({
      columnIndex: 16_383,
      rowIndex: 1_048_575
    })
  })

  it('rejects a reference past the Excel grid', () => {
    expect(parseXlsxCellReference('XFE1')).toBeNull()
    expect(parseXlsxCellReference('A1048577')).toBeNull()
  })

  it('rejects references that are missing a part', () => {
    expect(parseXlsxCellReference('')).toBeNull()
    expect(parseXlsxCellReference('A')).toBeNull()
    expect(parseXlsxCellReference('12')).toBeNull()
    expect(parseXlsxCellReference('A0')).toBeNull()
  })

  it('rejects lowercase, absolute and sheet-qualified references', () => {
    expect(parseXlsxCellReference('a1')).toBeNull()
    expect(parseXlsxCellReference('$A$1')).toBeNull()
    expect(parseXlsxCellReference('Sheet1!A1')).toBeNull()
    expect(parseXlsxCellReference('A1:B2')).toBeNull()
  })
})

describe('columnIndexFromXlsxLetters', () => {
  it('maps letters to zero-based indexes', () => {
    expect(columnIndexFromXlsxLetters('A')).toBe(0)
    expect(columnIndexFromXlsxLetters('Z')).toBe(25)
    expect(columnIndexFromXlsxLetters('AA')).toBe(26)
    expect(columnIndexFromXlsxLetters('BA')).toBe(52)
    expect(columnIndexFromXlsxLetters('XFD')).toBe(16_383)
  })

  it('rejects empty and non-letter input', () => {
    expect(columnIndexFromXlsxLetters('')).toBeNull()
    expect(columnIndexFromXlsxLetters('a')).toBeNull()
    expect(columnIndexFromXlsxLetters('A1')).toBeNull()
    expect(columnIndexFromXlsxLetters('XFE')).toBeNull()
  })
})

describe('xlsxColumnLettersFromIndex', () => {
  it('is the inverse of columnIndexFromXlsxLetters across the grid', () => {
    for (const letters of ['A', 'B', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']) {
      const index = columnIndexFromXlsxLetters(letters)
      expect(index).not.toBeNull()
      expect(xlsxColumnLettersFromIndex(index!)).toBe(letters)
    }
  })

  it('returns an empty label for an invalid index', () => {
    expect(xlsxColumnLettersFromIndex(-1)).toBe('')
    expect(xlsxColumnLettersFromIndex(1.5)).toBe('')
  })
})

describe('expandXlsxCellRange', () => {
  it('expands a single reference and a range', () => {
    expect(expandXlsxCellRange('D17')).toEqual([{ rowIndex: 16, columnIndex: 3 }])
    expect(expandXlsxCellRange('C21:C22')).toEqual([
      { rowIndex: 20, columnIndex: 2 },
      { rowIndex: 21, columnIndex: 2 }
    ])
  })

  it('expands a rectangular range row by row', () => {
    expect(expandXlsxCellRange('A1:B2')).toEqual([
      { rowIndex: 0, columnIndex: 0 },
      { rowIndex: 0, columnIndex: 1 },
      { rowIndex: 1, columnIndex: 0 },
      { rowIndex: 1, columnIndex: 1 }
    ])
  })

  it('accepts absolute, lowercase, reversed and sheet-qualified forms', () => {
    expect(expandXlsxCellRange('$D$17')).toEqual([{ rowIndex: 16, columnIndex: 3 }])
    expect(expandXlsxCellRange('d17')).toEqual([{ rowIndex: 16, columnIndex: 3 }])
    expect(expandXlsxCellRange('C22:C21')).toHaveLength(2)
    expect(expandXlsxCellRange("'Hoja 1'!D17")).toEqual([{ rowIndex: 16, columnIndex: 3 }])
  })

  it('refuses a range too large to be a sparkline', () => {
    // Why: a whole-column reference is not something an author charts into one cell.
    expect(expandXlsxCellRange('A1:A100000')).toEqual([])
  })

  it('returns nothing for something that is not a reference', () => {
    expect(expandXlsxCellRange('OFFSET(A1,0,1)')).toEqual([])
    expect(expandXlsxCellRange('')).toEqual([])
  })

  it('keeps its own thousand-cell budget', () => {
    expect(expandXlsxCellRange('A1:A1000')).toHaveLength(1000)
    expect(expandXlsxCellRange('A1:A1001')).toEqual([])
  })

  it('refuses a space-separated list, which is not one range', () => {
    expect(expandXlsxCellRange('A1:A2 B1:B2')).toEqual([])
  })
})

describe('expandXlsxCellRangeList', () => {
  const MAX_CELLS = 200_000

  it('expands one range row by row', () => {
    const cells = expandXlsxCellRangeList('B27:C44', MAX_CELLS)

    expect(cells).toHaveLength(36)
    expect(cells[0]).toEqual({ rowIndex: 26, columnIndex: 1 })
    expect(cells[1]).toEqual({ rowIndex: 26, columnIndex: 2 })
    expect(cells[2]).toEqual({ rowIndex: 27, columnIndex: 1 })
  })

  it('expands every range a sqref lists', () => {
    expect(expandXlsxCellRangeList('B27:C44 H27:H44', MAX_CELLS)).toHaveLength(54)
    expect(expandXlsxCellRangeList('A1', MAX_CELLS)).toEqual([{ rowIndex: 0, columnIndex: 0 }])
    expect(expandXlsxCellRangeList('A1:A3 C5', MAX_CELLS)).toHaveLength(4)
  })

  it('tolerates any run of whitespace between the ranges', () => {
    expect(expandXlsxCellRangeList('  A1:A2\n\tB1:B2  ', MAX_CELLS)).toHaveLength(4)
  })

  it('returns nothing for an empty list', () => {
    expect(expandXlsxCellRangeList('', MAX_CELLS)).toEqual([])
    expect(expandXlsxCellRangeList('   ', MAX_CELLS)).toEqual([])
  })

  it('reads absolute, lowercase and reversed forms as the same range', () => {
    const expected = expandXlsxCellRangeList('B27:C44', MAX_CELLS)

    expect(expandXlsxCellRangeList('$B$27:$C$44', MAX_CELLS)).toEqual(expected)
    expect(expandXlsxCellRangeList('b27:c44', MAX_CELLS)).toEqual(expected)
    expect(expandXlsxCellRangeList('C44:B27', MAX_CELLS)).toEqual(expected)
  })

  it('drops the sheet a qualified range names', () => {
    const expected = [
      { rowIndex: 0, columnIndex: 0 },
      { rowIndex: 1, columnIndex: 0 }
    ]

    expect(expandXlsxCellRangeList('Sheet1!A1:A2', MAX_CELLS)).toEqual(expected)
    expect(expandXlsxCellRangeList("'My Sheet'!A1:A2", MAX_CELLS)).toEqual(expected)
  })

  it('returns nothing for a range it cannot read', () => {
    for (const unreadable of ['ZZZ', '1A', 'B:B', 'A1:']) {
      expect(expandXlsxCellRangeList(unreadable, MAX_CELLS)).toEqual([])
    }
  })

  it('drops one unreadable range without taking its siblings with it', () => {
    expect(expandXlsxCellRangeList('A1:A2 NOPE', MAX_CELLS)).toHaveLength(2)
  })

  it('returns nothing when the budget is zero or negative', () => {
    expect(expandXlsxCellRangeList('A1', 0)).toEqual([])
    expect(expandXlsxCellRangeList('A1', -1)).toEqual([])
  })

  it('accepts a range that fills the budget exactly and refuses one past it', () => {
    expect(expandXlsxCellRangeList('A1:A3', 3)).toHaveLength(3)
    expect(expandXlsxCellRangeList('A1:A4', 3)).toEqual([])
  })

  it('spends the budget across the whole list, whatever order it is written in', () => {
    expect(expandXlsxCellRangeList('A1:A2 B1:B2', 4)).toHaveLength(4)
    expect(expandXlsxCellRangeList('A1:A2 B1:B2', 3)).toEqual([])
    expect(expandXlsxCellRangeList('B1:B2 A1:A2', 3)).toEqual([])
  })

  it('refuses a whole-sheet range without expanding it', () => {
    expect(expandXlsxCellRangeList('A1:XFD1048576', MAX_CELLS)).toEqual([])
  })
})
