import { expect, it } from 'vitest'
import { moveCsvSelection } from '../grid/csv-cell-selection'
import { copyCsvSelection, pasteCsvSelection } from './clipboard/csv-cell-clipboard'

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
