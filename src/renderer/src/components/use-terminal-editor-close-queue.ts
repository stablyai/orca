import { useCallback } from 'react'
import { useAppStore } from '../store'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import { appendUniqueOpenFileIds } from './terminal/unsaved-close-queue'
import { isPinnedActiveEditorTab } from './terminal-workspace-model'
import { selectWorkspaceSurface } from '@/lib/workspace-surface-reveal'
import type { TerminalEditorCloseFoundation } from './use-terminal-editor-close-foundation'

export function useTerminalEditorCloseQueue(controller: TerminalEditorCloseFoundation) {
  const {
    activeWorktreeId,
    closeFile,
    closedReactionsRef,
    inFlightSaveFileIdRef,
    pendingEditorCloseQueueRef,
    proceedToNativeWindowClose,
    setActiveFile,
    setActiveTabType,
    setSaveDialogFileId,
    windowCloseAfterDirtyRef
  } = controller
  const waitForFileClosed = useCallback((fileId: string, timeoutMs: number): Promise<boolean> => {
    if (!useAppStore.getState().openFiles.some((file) => file.id === fileId)) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let unsub: (() => void) | null = null
      const timeoutId = window.setTimeout(() => {
        unsub?.()
        resolve(false)
      }, timeoutMs)
      unsub = useAppStore.subscribe((state) => {
        if (!state.openFiles.some((file) => file.id === fileId)) {
          window.clearTimeout(timeoutId)
          unsub?.()
          resolve(true)
        }
      })
      if (!useAppStore.getState().openFiles.some((file) => file.id === fileId)) {
        window.clearTimeout(timeoutId)
        unsub?.()
        resolve(true)
      }
    })
  }, [])

  const settleQueuedClose = useCallback((fileId: string) => {
    pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
      (queuedId) => queuedId !== fileId
    )
    const onClosed = closedReactionsRef.current.get(fileId)
    closedReactionsRef.current.delete(fileId)
    onClosed?.()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
  }, [])

  const getNextQueuedEditorClose = useCallback((): string | null => {
    while (pendingEditorCloseQueueRef.current.length > 0) {
      const fileId = pendingEditorCloseQueueRef.current[0]
      if (inFlightSaveFileIdRef.current === fileId) {
        return null
      }
      const state = useAppStore.getState()
      if (!state.openFiles.some((candidate) => candidate.id === fileId)) {
        settleQueuedClose(fileId)
        continue
      }
      if (!needsSavePromptOnClose(state, fileId)) {
        closeFile(fileId)
        settleQueuedClose(fileId)
        continue
      }
      return fileId
    }
    return null
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
  }, [closeFile, settleQueuedClose])

  const advanceEditorCloseQueue = useCallback(() => {
    const nextFileId = getNextQueuedEditorClose()
    if (nextFileId) {
      const state = useAppStore.getState()
      const file = state.openFiles.find((candidate) => candidate.id === nextFileId)
      if (file && file.worktreeId !== state.activeWorktreeId) {
        selectWorkspaceSurface(state, file.worktreeId)
      }
      setActiveFile(nextFileId)
      setActiveTabType('editor', file?.worktreeId ?? state.activeWorktreeId)
      setSaveDialogFileId(nextFileId)
      return
    }
    setSaveDialogFileId(null)
    const pendingWindowClose = windowCloseAfterDirtyRef.current
    if (pendingWindowClose) {
      windowCloseAfterDirtyRef.current = null
      proceedToNativeWindowClose(pendingWindowClose.isQuitting)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [getNextQueuedEditorClose, proceedToNativeWindowClose, setActiveFile, setActiveTabType])

  const queueEditorCloseRequests = useCallback(
    (fileIds: string[], pendingWindowClose?: { isQuitting: boolean }) => {
      if (pendingWindowClose) {
        windowCloseAfterDirtyRef.current = pendingWindowClose
      }
      pendingEditorCloseQueueRef.current = appendUniqueOpenFileIds(
        pendingEditorCloseQueueRef.current,
        fileIds,
        new Set(useAppStore.getState().openFiles.map((file) => file.id))
      )
      advanceEditorCloseQueue()
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
    [advanceEditorCloseQueue]
  )

  const handleCloseFile = useCallback(
    (fileId: string) => {
      const state = useAppStore.getState()
      if (activeWorktreeId && isPinnedActiveEditorTab(state, activeWorktreeId, fileId)) {
        return
      }
      if (needsSavePromptOnClose(state, fileId)) {
        queueEditorCloseRequests([fileId])
        return
      }
      closeFile(fileId)
    },
    [activeWorktreeId, closeFile, queueEditorCloseRequests]
  )

  return {
    waitForFileClosed,
    settleQueuedClose,
    getNextQueuedEditorClose,
    advanceEditorCloseQueue,
    queueEditorCloseRequests,
    handleCloseFile
  }
}

export type TerminalEditorCloseQueueController = TerminalEditorCloseFoundation &
  ReturnType<typeof useTerminalEditorCloseQueue>
