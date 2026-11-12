import { useCallback, useRef } from 'react'
import { useAppStore } from '../store'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import { runAfterEditorFramesFlush } from './editor/save/flush/editor-pending-flush'
import { appendUniqueOpenFileIds } from './terminal/unsaved-close-queue'
import { isPinnedActiveEditorTab } from './terminal-workspace-model'
import {
  editorCloseTarget,
  editorTabNeedsSavePrompt
} from '@/store/slices/editor/tabs/editor-tab-close-target'
import {
  editorPlacementIndex,
  openFileIndex
} from '@/store/slices/editor/tabs/workspace-editor-files'
import { editorViewTab } from '@/store/slices/editor/tabs/editor-view-placement'
import { selectWorkspaceSurface } from '@/lib/workspace/activation/workspace-surface-reveal'
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
  const closeTabIds = useRef(new Map<string, string>())
  const queuedEditorCloseTabId = useCallback(
    (fileId: string) => closeTabIds.current.get(fileId),
    []
  )
  const waitForFileClosed = useCallback(
    (fileId: string, timeoutMs: number, tabId?: string): Promise<boolean> => {
      const isClosed = (state: ReturnType<typeof useAppStore.getState>) =>
        tabId
          ? !editorPlacementIndex(state.unifiedTabsByWorktree).workspaceByTabId.has(tabId)
          : !openFileIndex(state.openFiles).has(fileId)
      if (isClosed(useAppStore.getState())) {
        return Promise.resolve(true)
      }
      return new Promise((resolve) => {
        let unsub: (() => void) | null = null
        const timeoutId = window.setTimeout(() => {
          unsub?.()
          resolve(false)
        }, timeoutMs)
        unsub = useAppStore.subscribe((state) => {
          if (isClosed(state)) {
            window.clearTimeout(timeoutId)
            unsub?.()
            resolve(true)
          }
        })
        if (isClosed(useAppStore.getState())) {
          window.clearTimeout(timeoutId)
          unsub?.()
          resolve(true)
        }
      })
    },
    []
  )

  const settleQueuedClose = useCallback(
    (fileId: string) => {
      closeTabIds.current.delete(fileId)
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (queuedId) => queuedId !== fileId
      )
      const onClosed = closedReactionsRef.current.get(fileId)
      closedReactionsRef.current.delete(fileId)
      onClosed?.()
    },
    [closedReactionsRef, pendingEditorCloseQueueRef]
  )

  const getNextQueuedEditorClose = useCallback((): string | null => {
    while (pendingEditorCloseQueueRef.current.length > 0) {
      const fileId = pendingEditorCloseQueueRef.current[0]
      if (inFlightSaveFileIdRef.current === fileId) {
        return null
      }
      const state = useAppStore.getState()
      if (!openFileIndex(state.openFiles).has(fileId)) {
        settleQueuedClose(fileId)
        continue
      }
      const tabId = closeTabIds.current.get(fileId)
      const tab = tabId ? editorCloseTarget(state, tabId).tab : undefined
      if (tabId && !tab) {
        settleQueuedClose(fileId)
        continue
      }
      if (tab ? !editorTabNeedsSavePrompt(state, tab) : !needsSavePromptOnClose(state, fileId)) {
        if (tab) {
          state.closeUnifiedTab(tab.id)
        } else {
          closeFile(fileId)
        }
        settleQueuedClose(fileId)
        continue
      }
      return fileId
    }
    return null
  }, [closeFile, inFlightSaveFileIdRef, pendingEditorCloseQueueRef, settleQueuedClose])

  const advanceEditorCloseQueue = useCallback(() => {
    const nextFileId = getNextQueuedEditorClose()
    if (nextFileId) {
      const state = useAppStore.getState()
      const file = openFileIndex(state.openFiles).get(nextFileId)
      const tabId = closeTabIds.current.get(nextFileId)
      const tab = tabId ? editorCloseTarget(state, tabId).tab : undefined
      const workspaceId = tab?.worktreeId ?? file?.worktreeId ?? state.activeWorktreeId
      if (workspaceId && workspaceId !== state.activeWorktreeId) {
        selectWorkspaceSurface(state, workspaceId)
      }
      if (tab) {
        state.activateTab(tab.id, { preservePreview: true })
      }
      setActiveFile(nextFileId, workspaceId ?? undefined)
      setActiveTabType('editor', workspaceId)
      setSaveDialogFileId(nextFileId)
      return
    }
    setSaveDialogFileId(null)
    const pendingWindowClose = windowCloseAfterDirtyRef.current
    if (pendingWindowClose) {
      windowCloseAfterDirtyRef.current = null
      proceedToNativeWindowClose(pendingWindowClose.isQuitting)
    }
  }, [
    getNextQueuedEditorClose,
    proceedToNativeWindowClose,
    setActiveFile,
    setActiveTabType,
    setSaveDialogFileId,
    windowCloseAfterDirtyRef
  ])

  const queueEditorCloseRequests = useCallback(
    (fileIds: string[], pendingWindowClose?: { isQuitting: boolean }) => {
      if (pendingWindowClose) {
        windowCloseAfterDirtyRef.current = pendingWindowClose
      }
      const state = useAppStore.getState()
      if (pendingEditorCloseQueueRef.current.length === 0) {
        closeTabIds.current.clear()
      }
      const requests = fileIds.flatMap((id) => {
        const { file, tab } = editorCloseTarget(state, id)
        if (!file) {
          return []
        }
        if (tab && !pendingWindowClose) {
          closeTabIds.current.set(file.id, tab.id)
        } else {
          closeTabIds.current.delete(file.id)
        }
        return [file.id]
      })
      pendingEditorCloseQueueRef.current = appendUniqueOpenFileIds(
        pendingEditorCloseQueueRef.current,
        requests,
        new Set(useAppStore.getState().openFiles.map((file) => file.id))
      )
      advanceEditorCloseQueue()
    },
    [advanceEditorCloseQueue, pendingEditorCloseQueueRef, windowCloseAfterDirtyRef]
  )

  const handleCloseFile = useCallback(
    (id: string) => {
      const state = useAppStore.getState()
      const requested = editorCloseTarget(state, id)
      const file = requested.file
      if (!file) {
        return
      }
      const tab = requested.tab ?? editorViewTab(state, file.id)
      if (
        tab?.isPinned ||
        (activeWorktreeId && !tab && isPinnedActiveEditorTab(state, activeWorktreeId, file.id))
      ) {
        return
      }
      runAfterEditorFramesFlush(state, [file.id], () => {
        const latest = useAppStore.getState()
        const live = tab ? editorCloseTarget(latest, tab.id).tab : undefined
        if (tab && !live) {
          return
        }
        if (
          live ? editorTabNeedsSavePrompt(latest, live) : needsSavePromptOnClose(latest, file.id)
        ) {
          queueEditorCloseRequests([live?.id ?? file.id])
          return
        }
        if (live) {
          latest.closeUnifiedTab(live.id)
        } else {
          closeFile(file.id)
        }
      })
    },
    [activeWorktreeId, closeFile, queueEditorCloseRequests]
  )

  return {
    queuedEditorCloseTabId,
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
