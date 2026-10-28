import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import {
  ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  type EditorRequestFileCloseDetail,
  type EditorSaveAndCloseDetail
} from './editor/editor-autosave'
import {
  EDITOR_NOT_UTF8_SAVE_MESSAGE,
  EDITOR_STALE_SAVE_MESSAGE
} from './editor/editor-save-disk-precondition'
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
    let notClosedReason: 'blocked-stale' | 'not-utf8' | 'not-saved' | null = null
    const notClosed = new Promise<false>((resolve) => {
      const detail: EditorSaveAndCloseDetail = {
        fileId,
        onNotClosed: (reason) => {
          notClosedReason = reason
          resolve(false)
        }
      }
      window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail }))
    })
    inFlightSaveFileIdRef.current = fileId
    let closed = false
    try {
      // Why the race: a refused save keeps the tab open, so don't wait out the timeout for it.
      closed = await Promise.race([waitForFileClosed(fileId, 10_000), notClosed])
    } finally {
      if (inFlightSaveFileIdRef.current === fileId) {
        inFlightSaveFileIdRef.current = null
      }
    }
    if (!closed) {
      if (!useAppStore.getState().openFiles.some((candidate) => candidate.id === fileId)) {
        settleQueuedClose(fileId)
        advanceEditorCloseQueue()
        releaseCloseDialogGuardAfterDebounce()
        return
      }
      toast.error(
        notClosedReason === 'blocked-stale'
          ? translate('auto.components.editor.editor.save.stale.notice', EDITOR_STALE_SAVE_MESSAGE)
          : notClosedReason === 'not-utf8'
            ? translate(
                'auto.components.editor.editor.save.notUtf8.refused',
                EDITOR_NOT_UTF8_SAVE_MESSAGE
              )
            : translate(
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
  }, [
    advanceEditorCloseQueue,
    inFlightSaveFileIdRef,
    isClosingRef,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId,
    setSaveDialogFileId,
    settleQueuedClose,
    waitForFileClosed
  ])

  const handleSaveDialogDiscard = useCallback(async () => {
    if (isClosingRef.current || !saveDialogFileId) {
      return
    }
    isClosingRef.current = true
    const fileId = saveDialogFileId
    setSaveDialogFileId(null)
    await discardEditorFileChangesAndClose(fileId)
    settleQueuedClose(fileId)
    advanceEditorCloseQueue()
    releaseCloseDialogGuardAfterDebounce()
  }, [
    advanceEditorCloseQueue,
    isClosingRef,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId,
    setSaveDialogFileId,
    settleQueuedClose
  ])

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
  }, [
    closedReactionsRef,
    isClosingRef,
    pendingEditorCloseQueueRef,
    releaseCloseDialogGuardAfterDebounce,
    setSaveDialogFileId,
    windowCloseAfterDirtyRef
  ])

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
