import { useCallback } from 'react'
import { useAppStore } from '../store'
import { closeTerminalTab } from './terminal/terminal-tab-actions'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser-workspace-tab-close'
import { destroyWorkspaceWebviews } from '../store/slices/browser-webview-cleanup'
import {
  getActiveWorktreeRuntimeEnvironmentId,
  isPinnedEditorFileTab
} from './terminal-workspace-model'
import type { TerminalCloseController } from './use-terminal-close-actions'
import { useBulkTabCloseConfirmation } from './use-bulk-tab-close-confirmation'

export function useTerminalBulkCloseActions(
  controller: Pick<
    TerminalCloseController,
    'activeWorktreeId' | 'closeBrowserTab' | 'closeFile' | 'closeTab' | 'queueEditorCloseRequests'
  >
) {
  const { activeWorktreeId, closeBrowserTab, closeFile, closeTab, queueEditorCloseRequests } =
    controller
  const confirmBulkClose = useBulkTabCloseConfirmation()
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
        if (unifiedTab?.contentType === 'agent-session') {
          state.closeUnifiedTab(unifiedTab.id)
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

  const selectScopeTabIds = useCallback(
    (scope: 'others' | 'right' | 'left', tabId: string): string[] => {
      if (!activeWorktreeId) {
        return []
      }
      const state = useAppStore.getState()
      const order = state.tabBarOrderByWorktree[activeWorktreeId] ?? []
      const index = order.indexOf(tabId)
      if (index === -1) {
        return []
      }
      let ids = order.filter((id) => id !== tabId)
      if (scope === 'right') {
        ids = order.slice(index + 1)
      } else if (scope === 'left') {
        ids = order.slice(0, index)
      }
      const tabs = state.unifiedTabsByWorktree[activeWorktreeId] ?? []
      const pinnedIds = new Set(tabs.flatMap((tab) => (tab.isPinned ? [tab.id, tab.entityId] : [])))
      return ids.filter((id) => !pinnedIds.has(id))
    },
    [activeWorktreeId]
  )
  const handleCloseOthers = useCallback(
    (tabId: string) => {
      confirmBulkClose('others', () => selectScopeTabIds('others', tabId), closeTabBarTabs)
    },
    [closeTabBarTabs, confirmBulkClose, selectScopeTabIds]
  )
  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      confirmBulkClose('right', () => selectScopeTabIds('right', tabId), closeTabBarTabs)
    },
    [closeTabBarTabs, confirmBulkClose, selectScopeTabIds]
  )
  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => {
      confirmBulkClose('left', () => selectScopeTabIds('left', tabId), closeTabBarTabs)
    },
    [closeTabBarTabs, confirmBulkClose, selectScopeTabIds]
  )
  const handleCloseAllFiles = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    confirmBulkClose(
      'editors',
      () => {
        const state = useAppStore.getState()
        return state.openFiles
          .filter(
            (file) =>
              file.worktreeId === activeWorktreeId &&
              !isPinnedEditorFileTab(state, activeWorktreeId, file.id)
          )
          .map((file) => file.id)
      },
      (fileIds) => {
        const selectedIds = new Set(fileIds)
        const files = useAppStore.getState().openFiles.filter((file) => selectedIds.has(file.id))
        const dirtyFileIds = files.filter((file) => file.isDirty).map((file) => file.id)
        for (const file of files) {
          if (!file.isDirty) {
            closeFile(file.id)
          }
        }
        if (dirtyFileIds.length > 0) {
          queueEditorCloseRequests(dirtyFileIds)
        }
      }
    )
  }, [activeWorktreeId, closeFile, confirmBulkClose, queueEditorCloseRequests])

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
