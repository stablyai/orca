import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import {
  ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  type EditorRequestFileCloseDetail,
  type EditorSaveAndCloseDetail,
  type EditorSaveAndCloseOutcome
} from './editor/editor-autosave'
import { discardEditorFileChangesAndClose } from './editor/discard-editor-file-changes'
import { translate } from '@/i18n/i18n'
import type { TerminalEditorCloseQueueController } from './use-terminal-editor-close-queue'

export type TerminalEditorCloseDialogActionsInput = Pick<
  TerminalEditorCloseQueueController,
  | 'advanceEditorCloseQueue'
  | 'closedReactionsRef'
  | 'inFlightSaveFileIdRef'
  | 'isClosingRef'
  | 'pendingEditorCloseQueueRef'
  | 'queueEditorCloseRequests'
  | 'releaseCloseDialogGuardAfterDebounce'
  | 'saveDialogFileId'
  | 'setSaveDialogFileId'
  | 'settleQueuedClose'
  | 'waitForFileClosed'
  | 'windowCloseAfterDirtyRef'
>

export function useTerminalEditorCloseDialogActions(
  controller: TerminalEditorCloseDialogActionsInput
) {
  const {
    advanceEditorCloseQueue,
    closedReactionsRef,
    inFlightSaveFileIdRef,
    isClosingRef,
    pendingEditorCloseQueueRef,
    queueEditorCloseRequests,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId,
    setSaveDialogFileId,
    settleQueuedClose,
    waitForFileClosed,
    windowCloseAfterDirtyRef
  } = controller
  const handleSaveDialogSave = useCallback(async () => {
    if (isClosingRef.current || !saveDialogFileId) {
      return
    }
    isClosingRef.current = true
    const fileId = saveDialogFileId
    const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === fileId)
    if (!file) {
      settleQueuedClose(fileId)
      advanceEditorCloseQueue()
      releaseCloseDialogGuardAfterDebounce()
      return
    }

    setSaveDialogFileId(null)
    let outcome: EditorSaveAndCloseOutcome | undefined
    const settled = new Promise<boolean>((resolve) => {
      const detail: EditorSaveAndCloseDetail = {
        fileId,
        onSettled: (result) => {
          outcome = result
          resolve(result === 'closed')
        }
      }
      window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail }))
    })
    inFlightSaveFileIdRef.current = fileId
    let closed = false
    try {
      // Why race: the save reports its result at once; the timeout covers a controller that can't.
      closed = await Promise.race([settled, waitForFileClosed(fileId, 10_000)])
    } finally {
      if (inFlightSaveFileIdRef.current === fileId) {
        inFlightSaveFileIdRef.current = null
      }
    }
    // Why: the save landed, but a sibling's newer edits keep the tab open; that is no failure.
    // The tab never closed, so its close reaction must not fire. While quitting, ask again.
    if (outcome === 'kept-open') {
      closedReactionsRef.current.delete(fileId)
      pendingEditorCloseQueueRef.current = windowCloseAfterDirtyRef.current
        ? [fileId, ...pendingEditorCloseQueueRef.current.filter((id) => id !== fileId)]
        : pendingEditorCloseQueueRef.current.filter((id) => id !== fileId)
      isClosingRef.current = false
      advanceEditorCloseQueue()
      return
    }
    if (!closed) {
      if (!useAppStore.getState().openFiles.some((candidate) => candidate.id === fileId)) {
        settleQueuedClose(fileId)
        advanceEditorCloseQueue()
        releaseCloseDialogGuardAfterDebounce()
        return
      }
      toast.error(
        translate(
          'auto.components.Terminal.a2a279b32a',
          'Save timed out or failed. Fix errors before closing.'
        )
      )
      setSaveDialogFileId(fileId)
      isClosingRef.current = false
      return
    }
    settleQueuedClose(fileId)
    advanceEditorCloseQueue()
    releaseCloseDialogGuardAfterDebounce()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [
    advanceEditorCloseQueue,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId,
    waitForFileClosed
  ])

  const handleSaveDialogDiscard = useCallback(async () => {
    if (isClosingRef.current || !saveDialogFileId) {
      return
    }
    isClosingRef.current = true
    const fileId = saveDialogFileId
    setSaveDialogFileId(null)
    await discardEditorFileChangesAndClose(fileId, new Set(pendingEditorCloseQueueRef.current))
    settleQueuedClose(fileId)
    advanceEditorCloseQueue()
    releaseCloseDialogGuardAfterDebounce()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [advanceEditorCloseQueue, releaseCloseDialogGuardAfterDebounce, saveDialogFileId])

  const handleSaveDialogCancel = useCallback(() => {
    if (isClosingRef.current) {
      return
    }
    isClosingRef.current = true
    pendingEditorCloseQueueRef.current = []
    closedReactionsRef.current.clear()
    windowCloseAfterDirtyRef.current = null
    setSaveDialogFileId(null)
    releaseCloseDialogGuardAfterDebounce()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [releaseCloseDialogGuardAfterDebounce])

  useEffect(() => {
    const onRequestEditorClose = (event: Event): void => {
      const customEvent = event as CustomEvent<EditorRequestFileCloseDetail>
      const fileId = customEvent.detail?.fileId
      if (!fileId) {
        return
      }
      const onClosed = customEvent.detail?.onClosed
      if (onClosed) {
        closedReactionsRef.current.set(fileId, onClosed)
      }
      queueEditorCloseRequests([fileId])
    }
    window.addEventListener(
      ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
      onRequestEditorClose as EventListener
    )
    return () =>
      window.removeEventListener(
        ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
        onRequestEditorClose as EventListener
      )
  }, [closedReactionsRef, queueEditorCloseRequests])

  return { handleSaveDialogSave, handleSaveDialogDiscard, handleSaveDialogCancel }
}

export type TerminalEditorCloseController = TerminalEditorCloseQueueController &
  ReturnType<typeof useTerminalEditorCloseDialogActions>
