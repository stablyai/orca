import { useCallback } from 'react'
import { useAppStore } from '../store'
import { closeTerminalTab } from './terminal/terminal-tab-actions'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser-workspace-tab-close'
import { destroyWorkspaceWebviews } from '../store/slices/browser-webview-cleanup'
import {
  getActiveWorktreeRuntimeEnvironmentId,
  isPinnedEditorFileTab
} from './terminal-workspace-model'
import type { TerminalCloseController } from './use-terminal-close-actions'

export function useTerminalBulkCloseActions(controller: TerminalCloseController) {
  const { activeWorktreeId, closeBrowserTab, closeFile, closeTab, queueEditorCloseRequests } =
    controller
  const closeTabBarTabs = useCallback(
    (tabIds: string[]) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const dirtyFileIds: string[] = []
      for (const id of tabIds) {
        const unifiedTab = (state.unifiedTabsByWorktree[activeWorktreeId] ?? []).find(
          (candidate) => candidate.id === id || candidate.entityId === id
        )
        if (unifiedTab?.isPinned) {
          continue
        }
        let browserCloseOptions: { reason: 'cleanup' } | undefined
        if (unifiedTab?.contentType === 'browser') {
          const plan = closeBrowserWorkspaceTabOnHosts({
            state,
            worktreeId: activeWorktreeId,
            workspaceId: unifiedTab.entityId,
            visibleTabId: unifiedTab.id,
            focusedEnvironmentId: getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
          })
          if (!plan.closesLocally) {
            if (plan.removesVisibleTab) {
              state.closeUnifiedTab(unifiedTab.id)
            }
            continue
          }
          browserCloseOptions = plan.localCloseReason
            ? { reason: plan.localCloseReason }
            : undefined
        }
        if (
          unifiedTab?.contentType === 'terminal' &&
          isWebRuntimeSessionActive(getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId))
        ) {
          closeTerminalTab(unifiedTab.entityId, { skipRunningProcessConfirm: true })
          continue
        }
        if ((state.tabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
          closeTab(id)
        } else if (
          state.openFiles.some((file) => file.worktreeId === activeWorktreeId && file.id === id)
        ) {
          const file = state.openFiles.find((candidate) => candidate.id === id)
          if (file?.isDirty) {
            dirtyFileIds.push(id)
            continue
          }
          closeFile(id)
        } else if (
          (state.browserTabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)
        ) {
          closeBrowserTab(id, browserCloseOptions)
          // closeBrowserTab announces the MRU target before guest teardown can trigger bridge fallback.
          destroyWorkspaceWebviews(state.browserPagesByWorkspace, id)
        } else if (unifiedTab?.contentType === 'simulator') {
          state.closeUnifiedTab(unifiedTab.id)
        }
      }
      if (dirtyFileIds.length > 0) {
        queueEditorCloseRequests(dirtyFileIds)
      }
    },
    [activeWorktreeId, closeBrowserTab, closeFile, closeTab, queueEditorCloseRequests]
  )

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const order = useAppStore.getState().tabBarOrderByWorktree[activeWorktreeId] ?? []
      closeTabBarTabs(order.filter((id) => id !== tabId))
    },
    [activeWorktreeId, closeTabBarTabs]
  )
  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const currentOrder = useAppStore.getState().tabBarOrderByWorktree[activeWorktreeId] ?? []
      const index = currentOrder.indexOf(tabId)
      if (index === -1) {
        return
      }
      closeTabBarTabs(currentOrder.slice(index + 1))
    },
    [activeWorktreeId, closeTabBarTabs]
  )
  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const currentOrder = useAppStore.getState().tabBarOrderByWorktree[activeWorktreeId] ?? []
      const index = currentOrder.indexOf(tabId)
      if (index === -1) {
        return
      }
      closeTabBarTabs(currentOrder.slice(0, index))
    },
    [activeWorktreeId, closeTabBarTabs]
  )
  const handleCloseAllFiles = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const state = useAppStore.getState()
    const filesInWorktree = state.openFiles.filter((file) => file.worktreeId === activeWorktreeId)
    const closableFiles = filesInWorktree.filter(
      (file) => !isPinnedEditorFileTab(state, activeWorktreeId, file.id)
    )
    const dirtyFileIds = closableFiles.filter((file) => file.isDirty).map((file) => file.id)
    for (const file of closableFiles) {
      if (!file.isDirty) {
        closeFile(file.id)
      }
    }
    if (dirtyFileIds.length > 0) {
      queueEditorCloseRequests(dirtyFileIds)
    }
  }, [activeWorktreeId, closeFile, queueEditorCloseRequests])

  return {
    closeTabBarTabs,
    handleCloseOthers,
    handleCloseTabsToRight,
    handleCloseTabsToLeft,
    handleCloseAllFiles
  }
}

export type TerminalBulkCloseController = TerminalCloseController &
  ReturnType<typeof useTerminalBulkCloseActions>
