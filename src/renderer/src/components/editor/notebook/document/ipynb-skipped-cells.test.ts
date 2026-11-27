import { expect, it } from 'vitest'
import {
  deleteIpynbCell,
  moveIpynbCell,
  updateIpynbCellRuns,
  updateIpynbCellSources,
  withIpynbCellIds
} from './ipynb-cell-mutations'
import { parseIpynb } from './ipynb-parse'

const hiddenCell = { cell_type: 'future', source: ['keep'], extension: { version: 1 } }
const content = JSON.stringify({
  cells: [
    hiddenCell,
    { cell_type: 'code', source: ['first'] },
    null,
    { cell_type: 'raw', source: ['last'] }
  ]
})

it('prepares and saves execution to the visible cell without changing skipped cells', () => {
  expect(parseIpynb(content).cells.map((cell) => cell.source)).toEqual(['first', 'last'])
  const edited = updateIpynbCellSources(content, [{ index: 0, source: 'changed' }])
  const prepared = withIpynbCellIds(edited)
  const finished = updateIpynbCellRuns(prepared, [
    {
      index: 0,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'done\n' }],
      executionCount: 3
    }
  ])

  expect(JSON.parse(finished).cells).toEqual([
    hiddenCell,
    {
      cell_type: 'code',
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      source: ['changed'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['done\n'] }],
      execution_count: 3
    },
    null,
    { cell_type: 'raw', id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), source: ['last'] }
  ])
})

it('moves and deletes visible cells while preserving unsupported cells', () => {
  const moved = moveIpynbCell(content, 0, 1)
  expect(parseIpynb(moved).cells.map((cell) => cell.source)).toEqual(['last', 'first'])
  expect(JSON.parse(deleteIpynbCell(moved, 1)).cells).toEqual([
    hiddenCell,
    { cell_type: 'raw', source: ['last'] },
    null
  ])
})
