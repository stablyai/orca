// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { flushClosingEditorBuffers } from '../editor-pending-flush'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '../editor-autosave'
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

it("marks a pending cell's session clean when a sibling view of its record saved its text", async () => {
  const document = parseCsvTextDocument('a,b\n1,2', ',')
  const onSessionChange = vi.fn()
  function Probe(): null {
    const editingRef = useRef<CsvCellEditSession | null>({
      position: { row: 0, column: 1 },
      value: '3',
      sourceRow: 1,
      source: document.source,
      wasDirty: true
    })
    useCsvPendingCell({
      fileId: 'data.csv',
      commit: () => true,
      document,
      editingRef,
      onSessionChange
    })
    return null
  }
  const root = createRoot(window.document.createElement('div'))
  await act(async () => root.render(<Probe />))
  try {
    // The saving view closed mid-write; the event lists the record's views.
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_FILE_SAVED_EVENT, {
        detail: {
          fileId: 'closed',
          content: document.source,
          recordViewIds: ['closed', 'data.csv']
        }
      })
    )
    expect(onSessionChange).toHaveBeenCalledWith(expect.objectContaining({ wasDirty: false }))
  } finally {
    await act(async () => root.unmount())
  }
})
