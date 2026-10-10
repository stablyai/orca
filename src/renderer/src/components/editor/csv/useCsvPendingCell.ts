import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { registerPendingEditorFlush } from '../editor-pending-flush'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '../editor-autosave'
import type { CsvTextDocument } from './csv-text-document'
import { editCsvTextCells } from './csv-text-cell-edits'
import type { CsvCellEditSession } from './csv-grid-interaction'

export function useCsvPendingCell({
  fileId,
  commit,
  document,
  onContentChange,
  editingRef,
  onSessionChange
}: {
  fileId?: string
  commit: () => boolean
  document: CsvTextDocument | null
  onContentChange?: (content: string) => void
  editingRef: RefObject<CsvCellEditSession | null>
  onSessionChange: (session: CsvCellEditSession) => void
}) {
  const latest = useRef({ commit, document, onContentChange, onSessionChange })
  useLayoutEffect(() => {
    latest.current = { commit, document, onContentChange, onSessionChange }
  })
  useEffect(() => {
    if (!fileId) {
      return
    }
    const unregister = registerPendingEditorFlush(
      fileId,
      () => {
        if (!latest.current.commit()) {
          throw new Error('Resolve the pending CSV cell edit before saving.')
        }
      },
      () => {
        const draft = editingRef.current
        return Boolean(
          draft &&
          draft.value !==
            (latest.current.document?.rows[draft.sourceRow]?.[draft.position.column] ?? '')
        )
      }
    )
    const saved = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return
      }
      const detail: unknown = event.detail
      if (
        typeof detail !== 'object' ||
        detail === null ||
        !('fileId' in detail) ||
        detail.fileId !== fileId ||
        !('content' in detail)
      ) {
        return
      }
      const draft = editingRef.current
      if (draft && draft.source === detail.content) {
        latest.current.onSessionChange({ ...draft, wasDirty: false })
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, saved)
    return () => {
      unregister()
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, saved)
    }
  }, [fileId, editingRef])
  return useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        return
      }
      const draft = editingRef.current
      const snapshot = latest.current
      if (!draft || !snapshot.document || draft.source !== snapshot.document.source) {
        return
      }
      snapshot.onContentChange?.(
        editCsvTextCells(
          snapshot.document,
          [{ row: draft.sourceRow, column: draft.position.column, value: draft.value }],
          true
        )
      )
      editingRef.current = null
    },
    [editingRef]
  )
}
