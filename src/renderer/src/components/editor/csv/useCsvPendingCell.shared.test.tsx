// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { flushPendingEditorChange } from '../editor-pending-flush'
import { editCsvTextCells } from './csv-text-cell-edits'
import { parseCsvTextDocument } from './csv-text-document'
import type { CsvCellEditSession } from './csv-grid-interaction'
import { useCsvPendingCell } from './useCsvPendingCell'

it('two tabs of one CSV editing different cells keep both cells when both flush', () => {
  // The shared record's draft: every tab's commit lands here at once, as the store fans it out.
  let shared: string | undefined
  const document = parseCsvTextDocument('name,qty\na,1\nb,2\n', ',')
  const mount = (fileId: string, session: CsvCellEditSession) =>
    renderHook(() => {
      const editingRef = { current: session }
      return useCsvPendingCell({
        fileId,
        document,
        editingRef,
        onSessionChange: () => {},
        onContentChange: (next) => {
          shared = next
        },
        readSharedContent: () => shared,
        // The grid's own commit edits this tab's cached document.
        commit: () => {
          const draft = editingRef.current
          shared = editCsvTextCells(document, [
            { row: draft.sourceRow, column: draft.position.column, value: draft.value }
          ])
          return true
        }
      })
    })
  const cell = (row: number, value: string): CsvCellEditSession => ({
    position: { row, column: 1 },
    sourceRow: row,
    value,
    source: document.source,
    wasDirty: false
  })
  mount('csv-tab-a', cell(1, '10'))
  mount('csv-tab-b', cell(2, '20'))

  act(() => {
    flushPendingEditorChange('csv-tab-a')
    flushPendingEditorChange('csv-tab-b')
  })

  expect(shared).toBe('name,qty\na,10\nb,20\n')
})
