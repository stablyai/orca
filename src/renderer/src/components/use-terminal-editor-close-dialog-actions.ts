import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import {
  ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
  requestEditorSaveAndClose,
  type EditorRequestFileCloseDetail
} from './editor/editor-autosave'
import { discardEditorFileChangesAndClose } from './editor/discard-editor-file-changes'
import { translate } from '@/i18n/i18n'
import type { TerminalEditorCloseQueueController } from './use-terminal-editor-close-queue'

export type TerminalEditorCloseDialogActionsInput = Pick<
  TerminalEditorCloseQueueController,
  | 'advanceEditorCloseQueue'
  | 'inFlightSaveFileIdRef'
  | 'isClosingRef'
  | 'pendingEditorCloseQueueRef'
  | 'queueEditorCloseRequests'
  | 'releaseCloseDialogGuardAfterDebounce'
  | 'saveDialogFileId'
  | 'setSaveDialogFileId'
  | 'windowCloseAfterDirtyRef'
>

export function useTerminalEditorCloseDialogActions(
  controller: TerminalEditorCloseDialogActionsInput
) {
  const {
    advanceEditorCloseQueue,
    inFlightSaveFileIdRef,
    isClosingRef,
    pendingEditorCloseQueueRef,
    queueEditorCloseRequests,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId,
    setSaveDialogFileId,
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
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (id) => id !== fileId
      )
      advanceEditorCloseQueue()
      releaseCloseDialogGuardAfterDebounce()
      return
    }

    setSaveDialogFileId(null)
    inFlightSaveFileIdRef.current = fileId
    let result: Awaited<ReturnType<typeof requestEditorSaveAndClose>>
    try {
      result = await requestEditorSaveAndClose(fileId)
    } finally {
      if (inFlightSaveFileIdRef.current === fileId) {
        inFlightSaveFileIdRef.current = null
      }
    }
    if (result !== 'closed') {
      if (!useAppStore.getState().openFiles.some((candidate) => candidate.id === fileId)) {
        pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
          (id) => id !== fileId
        )
        advanceEditorCloseQueue()
        releaseCloseDialogGuardAfterDebounce()
        return
      }
      if (result === 'failed') {
        toast.error(
          translate(
            'auto.components.Terminal.a2a279b32a',
            'Save timed out or failed. Fix errors before closing.'
          )
        )
      }
      setSaveDialogFileId(fileId)
      isClosingRef.current = false
      return
    }
    pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
      (id) => id !== fileId
    )
    advanceEditorCloseQueue()
    releaseCloseDialogGuardAfterDebounce()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [advanceEditorCloseQueue, releaseCloseDialogGuardAfterDebounce, saveDialogFileId])

  const handleSaveDialogDiscard = useCallback(async () => {
    if (isClosingRef.current || !saveDialogFileId) {
      return
    }
    isClosingRef.current = true
    const fileId = saveDialogFileId
    setSaveDialogFileId(null)
    await discardEditorFileChangesAndClose(fileId)
    pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
      (id) => id !== fileId
    )
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
  }, [queueEditorCloseRequests])

  return { handleSaveDialogSave, handleSaveDialogDiscard, handleSaveDialogCancel }
}

export type TerminalEditorCloseController = TerminalEditorCloseQueueController &
  ReturnType<typeof useTerminalEditorCloseDialogActions>
