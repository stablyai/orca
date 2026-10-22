// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { flushClosingEditorBuffers } from '../editor-pending-flush'
import { EMPTY_EDITOR_BUFFER_VIEW_INDEX as NO_SHARING } from '@/store/slices/editor/buffers/editor-buffer-views'
import { CSV_RECORD_BYTES } from './csv-byte-index'
import type { CsvCellEditSession } from './csv-grid-interaction'
import { parseCsvTextDocument } from './csv-text-document'
import { useCsvPendingCell } from './useCsvPendingCell'

it('keeps an over-limit pending cell as draft text when its tab closes', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const document = parseCsvTextDocument('a,b\n1,2', ',')
  const huge = 'x'.repeat(CSV_RECORD_BYTES + 1)
  const onContentChange = vi.fn()
  function Probe(): null {
    const editingRef = useRef<CsvCellEditSession | null>({
      position: { row: 0, column: 1 },
      value: huge,
      sourceRow: 1,
      source: document.source,
      wasDirty: false
    })
    // A commit refuses the cell, as the table size limit does.
    useCsvPendingCell({
      fileId: 'data.csv',
      commit: () => false,
      document,
      onContentChange,
      editingRef,
      onSessionChange: () => {}
    })
    return null
  }
  const root = createRoot(window.document.createElement('div'))
  await act(async () => root.render(<Probe />))
  try {
    flushClosingEditorBuffers(NO_SHARING, ['data.csv'])
    expect(onContentChange).toHaveBeenCalledWith(`a,b\n1,${huge}`)
  } finally {
    await act(async () => root.unmount())
  }
})
