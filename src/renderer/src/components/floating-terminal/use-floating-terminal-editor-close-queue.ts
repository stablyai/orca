import { useCallback, useEffect } from 'react'
import { useTerminalSaveDialog } from '@/components/terminal/useTerminalSaveDialog'
import { appendUniqueOpenFileIds } from '@/components/terminal/unsaved-close-queue'
import { useAppStore } from '@/store'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'

type FloatingTerminalEditorCloseQueueInput = Pick<
  FloatingTerminalPanelStoreState,
  'floatingFiles' | 'closeFile' | 'markFileDirty'
> &
  Pick<
    FloatingTerminalPanelLocalState,
    'pendingEditorCloseQueueRef' | 'pendingReclaimArmByFileIdRef' | 'saveDialogFileIdRef'
  >

export function useFloatingTerminalEditorCloseQueue({
  floatingFiles,
  closeFile,
  markFileDirty,
  pendingEditorCloseQueueRef,
  pendingReclaimArmByFileIdRef,
  saveDialogFileIdRef
}: FloatingTerminalEditorCloseQueueInput) {
  const {
    saveDialogFileId,
    saveDialogFile,
    requestCloseFile,
    handleSaveDialogSave,
    handleSaveDialogDiscard,
    handleSaveDialogCancel
  } = useTerminalSaveDialog({ openFiles: floatingFiles, closeFile, markFileDirty })

  const getNextQueuedEditorClose = useCallback((): string | null => {
    while (pendingEditorCloseQueueRef.current.length > 0) {
      const fileId = pendingEditorCloseQueueRef.current[0]
      const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === fileId)
      if (!file) {
        pendingEditorCloseQueueRef.current.shift()
        continue
      }
      if (!file.isDirty) {
        closeFile(fileId)
        pendingEditorCloseQueueRef.current.shift()
        continue
      }
      return fileId
    }
    return null
  }, [closeFile, pendingEditorCloseQueueRef])

  const advanceEditorCloseQueue = useCallback(() => {
    if (saveDialogFileIdRef.current !== null) {
      return
    }
    const nextFileId = getNextQueuedEditorClose()
    if (!nextFileId) {
      return
    }
    saveDialogFileIdRef.current = nextFileId
    requestCloseFile(nextFileId)
  }, [getNextQueuedEditorClose, requestCloseFile, saveDialogFileIdRef])

  const queueEditorCloseRequests = useCallback(
    (fileIds: string[]) => {
      pendingEditorCloseQueueRef.current = appendUniqueOpenFileIds(
        pendingEditorCloseQueueRef.current,
        fileIds,
        new Set(useAppStore.getState().openFiles.map((file) => file.id))
      )
      advanceEditorCloseQueue()
    },
    [advanceEditorCloseQueue, pendingEditorCloseQueueRef]
  )

  useEffect(() => {
    saveDialogFileIdRef.current = saveDialogFileId
    if (saveDialogFileId === null) {
      advanceEditorCloseQueue()
    }
  }, [advanceEditorCloseQueue, saveDialogFileId, saveDialogFileIdRef])

  const handleFloatingSaveDialogSave = useCallback(() => {
    const fileId = saveDialogFileIdRef.current
    if (fileId) {
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (queuedId) => queuedId !== fileId
      )
    }
    handleSaveDialogSave()
  }, [handleSaveDialogSave, pendingEditorCloseQueueRef, saveDialogFileIdRef])

  const handleFloatingSaveDialogDiscard = useCallback(() => {
    const fileId = saveDialogFileIdRef.current
    if (fileId) {
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (queuedId) => queuedId !== fileId
      )
    }
    void Promise.resolve(handleSaveDialogDiscard())
  }, [handleSaveDialogDiscard, pendingEditorCloseQueueRef, saveDialogFileIdRef])

  const handleFloatingSaveDialogCancel = useCallback(() => {
    pendingEditorCloseQueueRef.current = []
    pendingReclaimArmByFileIdRef.current.clear()
    handleSaveDialogCancel()
  }, [handleSaveDialogCancel, pendingEditorCloseQueueRef, pendingReclaimArmByFileIdRef])

  return {
    saveDialogFileId,
    saveDialogFile,
    queueEditorCloseRequests,
    handleFloatingSaveDialogSave,
    handleFloatingSaveDialogDiscard,
    handleFloatingSaveDialogCancel
  }
}

export type FloatingTerminalEditorCloseQueue = ReturnType<
  typeof useFloatingTerminalEditorCloseQueue
>
