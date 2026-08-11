import { describe, expect, it, vi } from 'vitest'
import {
  buildSpreadsheetMergeIndex,
  planSpreadsheetMergePlacement,
  sumSpreadsheetRowHeights
} from './spreadsheet-merged-cells'
import type { XlsxMergedRange } from './xlsx-worksheet-layout'

const BANNER: XlsxMergedRange = { rowIndex: 1, columnIndex: 1, rowSpan: 4, columnSpan: 6 }

describe('buildSpreadsheetMergeIndex', () => {
  it('finds a merge from any cell it covers', () => {
    const index = buildSpreadsheetMergeIndex([BANNER])

    expect(index.find(1, 1)).toBe(BANNER)
    expect(index.find(4, 6)).toBe(BANNER)
    expect(index.find(2, 3)).toBe(BANNER)
  })

  it('does not find a merge just outside its range', () => {
    const index = buildSpreadsheetMergeIndex([BANNER])

    expect(index.find(0, 1)).toBeUndefined()
    expect(index.find(5, 1)).toBeUndefined()
    expect(index.find(1, 0)).toBeUndefined()
    expect(index.find(1, 7)).toBeUndefined()
  })

  it('costs one slot per covered row, not per covered cell', () => {
    // Why: a merge may legally span a whole column, so indexing per cell would
    // allocate millions of entries for one range.
    const wholeColumn: XlsxMergedRange = {
      rowIndex: 0,
      columnIndex: 0,
      rowSpan: 100_000,
      columnSpan: 200
    }
    const index = buildSpreadsheetMergeIndex([wholeColumn])

    expect(index.truncated).toBe(false)
    expect(index.find(99_999, 199)).toBe(wholeColumn)
  })

  it('drops merges past the slot budget and says so', () => {
    const tall: XlsxMergedRange = { rowIndex: 0, columnIndex: 0, rowSpan: 150_000, columnSpan: 1 }
    const alsoTall: XlsxMergedRange = {
      rowIndex: 0,
      columnIndex: 5,
      rowSpan: 150_000,
      columnSpan: 1
    }
    const index = buildSpreadsheetMergeIndex([tall, alsoTall])

    expect(index.truncated).toBe(true)
    expect(index.find(0, 0)).toBe(tall)
    expect(index.find(0, 5)).toBeUndefined()
  })

  it('returns an empty index for a sheet with no merges', () => {
    const index = buildSpreadsheetMergeIndex([])

    expect(index.find(0, 0)).toBeUndefined()
    expect(index.truncated).toBe(false)
  })
})

describe('sumSpreadsheetRowHeights', () => {
  const merge = (rowIndex: number, rowSpan: number): XlsxMergedRange => ({
    rowIndex,
    columnIndex: 1,
    rowSpan,
    columnSpan: 4
  })

  it('gives a merge of a single row exactly that row height', () => {
    expect(sumSpreadsheetRowHeights(merge(3, 1), () => 24)).toBe(24)
  })

  it('adds the two rows a merge covers', () => {
    const heights = [0, 0, 0, 0, 0, 0, 0, 30, 45]

    expect(sumSpreadsheetRowHeights(merge(7, 2), (row) => heights[row] ?? 0)).toBe(75)
  })

  it('adds all four rows a taller merge covers', () => {
    expect(sumSpreadsheetRowHeights(merge(2, 4), () => 20)).toBe(80)
  })

  it('sums uneven row heights instead of averaging or repeating the first', () => {
    const heights = [24, 28, 40]

    expect(sumSpreadsheetRowHeights(merge(0, 3), (row) => heights[row] ?? 0)).toBe(92)
  })

  it('starts at the row the merge anchors on, not at the top of the sheet', () => {
    const heights = new Map([
      [0, 500],
      [1, 500],
      [20, 18],
      [21, 22]
    ])

    expect(sumSpreadsheetRowHeights(merge(20, 2), (row) => heights.get(row) ?? 0)).toBe(40)
  })

  it('counts a row of no height as nothing rather than failing', () => {
    const heights = [0, 32]

    expect(sumSpreadsheetRowHeights(merge(0, 2), (row) => heights[row] ?? 0)).toBe(32)
  })

  it('returns nothing for a range that claims to cover no rows', () => {
    const getRowHeight = vi.fn(() => 24)

    expect(sumSpreadsheetRowHeights(merge(8, 0), getRowHeight)).toBe(0)
    expect(getRowHeight).not.toHaveBeenCalled()
  })

  it('asks for each covered row once, in order, and for no other row', () => {
    const getRowHeight = vi.fn(() => 24)

    sumSpreadsheetRowHeights(merge(7, 3), getRowHeight)

    expect(getRowHeight.mock.calls).toEqual([[7], [8], [9]])
  })

  it('gives a title merged down two 24px rows the whole 48px band', () => {
    const titleMerge: XlsxMergedRange = { rowIndex: 7, columnIndex: 1, rowSpan: 2, columnSpan: 4 }

    expect(sumSpreadsheetRowHeights(titleMerge, () => 24)).toBe(48)
  })
})

describe('planSpreadsheetMergePlacement', () => {
  const plan = (rowIndex: number, columnIndex: number, first = 0, last = 20) =>
    planSpreadsheetMergePlacement({
      merge: BANNER,
      rowIndex,
      columnIndex,
      firstRenderedColumn: first,
      lastRenderedColumn: last
    })

  it('spans the merge from its anchor and shows the value there', () => {
    expect(plan(1, 1)).toEqual({ columnSpan: 6, showsValue: true })
  })

  it('paints the band on covered rows without repeating the value', () => {
    expect(plan(2, 1)).toEqual({ columnSpan: 6, showsValue: false })
    expect(plan(4, 1)).toEqual({ columnSpan: 6, showsValue: false })
  })

  it('returns null for a cell another cell of the merge already covers', () => {
    expect(plan(1, 2)).toBeNull()
    expect(plan(1, 6)).toBeNull()
  })

  it('starts at the first rendered column when the anchor is scrolled past', () => {
    // Why: the band must still render, but the value belongs to the anchor, so it
    // is not repeated into a column that does not own it.
    expect(plan(1, 3, 3, 20)).toEqual({ columnSpan: 4, showsValue: false })
    expect(plan(1, 1, 3, 20)).toBeNull()
  })

  it('clamps the span to the columns actually rendered on the right', () => {
    // Why: a span longer than the rendered tracks would eat the trailing spacer
    // and knock the row out of alignment with the header.
    expect(plan(1, 1, 0, 3)).toEqual({ columnSpan: 3, showsValue: true })
  })

  it('never spans less than one track', () => {
    expect(plan(1, 6, 6, 6)).toEqual({ columnSpan: 1, showsValue: false })
  })
})
