import { expect, it } from 'vitest'
import { moveCsvSelection } from '../grid/csv-cell-selection'
import { csvInspectionRows, csvSourceRow } from './csv-inspection'
import { copyCsvSelection, pasteCsvSelection } from './clipboard/csv-cell-clipboard'
import { mutateCsvTextDocument, parseCsvTextDocument } from '../document/csv-text-document'

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
