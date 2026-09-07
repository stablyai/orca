import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import {
  ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  type EditorRequestFileCloseDetail,
  requestEditorSaveQuiesce
} from './editor/editor-autosave'
import { translate } from '@/i18n/i18n'
import type { TerminalEditorCloseQueueController } from './use-terminal-editor-close-queue'

export function useTerminalEditorCloseDialogActions(
  controller: TerminalEditorCloseQueueController
) {
  const {
    advanceEditorCloseQueue,
    closeFile,
    inFlightSaveFileIdRef,
    isClosingRef,
    markFileDirty,
    pendingEditorCloseQueueRef,
    queueEditorCloseRequests,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId,
    setSaveDialogFileId,
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
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (id) => id !== fileId
      )
      advanceEditorCloseQueue()
      releaseCloseDialogGuardAfterDebounce()
      return
    }

    setSaveDialogFileId(null)
    window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId } }))
    inFlightSaveFileIdRef.current = fileId
    let closed = false
    try {
      closed = await waitForFileClosed(fileId, 10_000)
    } finally {
      if (inFlightSaveFileIdRef.current === fileId) {
        inFlightSaveFileIdRef.current = null
      }
    }
    if (!closed) {
      if (!useAppStore.getState().openFiles.some((candidate) => candidate.id === fileId)) {
        pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
          (id) => id !== fileId
        )
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
    pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
      (id) => id !== fileId
    )
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
    try {
      await requestEditorSaveQuiesce({ fileId })
    } catch (error) {
      console.warn('Autosave quiesce failed before discard', error)
    }
    markFileDirty(fileId, false)
    closeFile(fileId)
    pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
      (id) => id !== fileId
    )
    advanceEditorCloseQueue()
    releaseCloseDialogGuardAfterDebounce()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [
    advanceEditorCloseQueue,
    closeFile,
    markFileDirty,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId
  ])

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
