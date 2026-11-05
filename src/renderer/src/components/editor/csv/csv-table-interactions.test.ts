import { expect, it } from 'vitest'
import { csvCellIsSelected, csvSelectionBounds, moveCsvSelection } from './csv-cell-selection'
import { csvInspectionRows, csvSourceRow } from './csv-inspection'
import { copyCsvSelection, pasteCsvSelection } from './csv-cell-clipboard'
import { mutateCsvTextDocument, parseCsvTextDocument } from './csv-text-document'

it('retains the selection anchor when extending backwards and collapses on normal movement', () => {
  const first = moveCsvSelection(null, 3, 2, false)
  const extended = moveCsvSelection(first, 1, 0, true)
  expect(extended.anchor).toEqual({ row: 3, column: 2 })
  expect(csvSelectionBounds(extended)).toEqual({
    firstRow: 1,
    lastRow: 3,
    firstColumn: 0,
    lastColumn: 2
  })
  expect(csvCellIsSelected(extended, 2, 1)).toBe(true)
  expect(csvCellIsSelected(extended, 0, 1)).toBe(false)
  expect(moveCsvSelection(extended, 2, 1, false).anchor).toEqual({ row: 2, column: 1 })
})

it('sorts and filters for inspection without mutating source order and edits the original row', () => {
  const document = parseCsvTextDocument('name,value\nb,10\na,2\na,1', ',')
  const view = csvInspectionRows(document.rows, 'a', { column: 1, direction: 'ascending' })
  expect(view).toEqual([3, 2])
  expect(csvSourceRow(0, view)).toBe(0)
  const result = mutateCsvTextDocument(document, {
    kind: 'cells',
    edits: [{ row: csvSourceRow(1, view), column: 1, value: 'changed' }]
  })
  expect(result).toBe('name,value\nb,10\na,2\na,changed')
  expect(document.source).toBe('name,value\nb,10\na,2\na,1')
})

it('copies and pastes rectangular quoted TSV without losing embedded CRLF or trailing blanks', () => {
  const rows = [
    ['a', 'b', 'c'],
    ['line\r\nline', 'quote"', ''],
    ['last', 'x', '']
  ]
  const selection = moveCsvSelection(moveCsvSelection(null, 1, 0, false), 2, 2, true)
  const copied = copyCsvSelection(selection, rows, null)
  expect(copied).toBe('"line\r\nline"\t"quote"""\t\nlast\tx\t')
  expect(pasteCsvSelection(copied, selection, rows, 3, null)).toEqual([
    { row: 1, column: 0, value: 'line\r\nline' },
    { row: 1, column: 1, value: 'quote"' },
    { row: 1, column: 2, value: '' },
    { row: 2, column: 0, value: 'last' },
    { row: 2, column: 1, value: 'x' },
    { row: 2, column: 2, value: '' }
  ])
})

it('fills a selected range with one literal value and rejects partial or oversized pastes', () => {
  const rows = [
    ['a', 'b'],
    ['x', 'y'],
    ['z', 'w']
  ]
  const selection = moveCsvSelection(moveCsvSelection(null, 1, 0, false), 2, 1, true)
  expect(pasteCsvSelection('=literal', selection, rows, 2, [2, 1])).toEqual([
    { row: 2, column: 0, value: '=literal' },
    { row: 2, column: 1, value: '=literal' },
    { row: 1, column: 0, value: '=literal' },
    { row: 1, column: 1, value: '=literal' }
  ])
  expect(() => pasteCsvSelection('1\t2\t3', selection, rows, 2, null)).toThrow('exceeds the table')
  const huge = moveCsvSelection(moveCsvSelection(null, 0, 0, false), 100_000, 1, true)
  expect(() => pasteCsvSelection('x', huge, rows, 2, null)).toThrow()
})
