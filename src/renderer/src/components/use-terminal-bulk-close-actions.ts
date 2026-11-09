import { useCallback } from 'react'
import { useAppStore } from '../store'
import { editorTabsNeedingSavePrompt } from '@/store/slices/editor/tabs/editor-tab-close-target'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { afterPendingTabs } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import {
  hasEditorFrameFlush,
  runAfterEditorFramesFlush
} from './editor/save/flush/editor-pending-flush'
import { closeTerminalTab } from './terminal/terminal-tab-actions'
import { isWebRuntimeSessionActive } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser/closing/browser-workspace-tab-close'
import { destroyWorkspaceWebviews } from '../store/slices/browser/cleanup/browser-webview-cleanup'
import { getActiveWorktreeRuntimeEnvironmentId } from './terminal-workspace-model'
import type { TerminalCloseController } from './use-terminal-close-actions'
import { useBulkTabCloseConfirmation } from './use-bulk-tab-close-confirmation'

export function useTerminalBulkCloseActions(
  controller: Pick<
    TerminalCloseController,
    'activeWorktreeId' | 'closeBrowserTab' | 'closeFile' | 'closeTab' | 'queueEditorCloseRequests'
  >
) {
  const { activeWorktreeId, closeBrowserTab, closeTab, queueEditorCloseRequests } = controller
  const confirmBulkClose = useBulkTabCloseConfirmation()
  const closeTabBarTabsNow = useCallback(
    (tabIds: string[]) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const tabs = state.unifiedTabsByWorktree[activeWorktreeId] ?? []
      const byId = new Map(tabs.map((tab) => [tab.id, tab]))
      const byEntity = new Map(tabs.map((tab) => [tab.entityId, tab]))
      const selectedEditors = [
        ...new Set(
          tabIds.flatMap((id) => {
            const tab = byId.get(id) ?? byEntity.get(id)
            return tab && !tab.isPinned && isEditorTabContentType(tab.contentType) ? [tab] : []
          })
        )
      ]
      const promptIds = editorTabsNeedingSavePrompt(state, selectedEditors)
      const closingEditorIds = selectedEditors
        .filter((tab) => !promptIds.has(tab.id))
        .map((tab) => tab.id)
      for (const id of tabIds) {
        const unifiedTab = byId.get(id) ?? byEntity.get(id)
        if (unifiedTab?.isPinned) {
          continue
        }
        if (unifiedTab && isEditorTabContentType(unifiedTab.contentType)) {
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
          closeTerminalTab(unifiedTab.entityId, { reason: 'user', skipRunningProcessConfirm: true })
          continue
        }
        if (unifiedTab?.contentType === 'agent-session') {
          state.closeUnifiedTab(unifiedTab.id)
          continue
        }
        if ((state.tabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
          closeTab(id)
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
      state.closeUnifiedTabs(closingEditorIds)
      if (promptIds.size > 0) {
        afterPendingTabs(closingEditorIds, () => queueEditorCloseRequests([...promptIds]))
      }
    },
    [activeWorktreeId, closeBrowserTab, closeTab, queueEditorCloseRequests]
  )
  const closeTabBarTabs = useCallback(
    (tabIds: string[]) => {
      const state = useAppStore.getState()
      const tabs = activeWorktreeId ? (state.unifiedTabsByWorktree[activeWorktreeId] ?? []) : []
      const entityByTab = new Map(tabs.map((tab) => [tab.id, tab.entityId]))
      const fileIdOf = (id: string): string => entityByTab.get(id) ?? id
      // Why: a custom editor frame may still hold edits the dirty checks must see; only its tabs wait.
      const framed = tabIds.filter((id) => hasEditorFrameFlush(state, fileIdOf(id)))
      const framedIds = new Set(framed)
      closeTabBarTabsNow(tabIds.filter((id) => !framedIds.has(id)))
      if (framed.length > 0) {
        runAfterEditorFramesFlush(state, framed.map(fileIdOf), () => closeTabBarTabsNow(framed))
      }
    },
    [activeWorktreeId, closeTabBarTabsNow]
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
      () =>
        (useAppStore.getState().unifiedTabsByWorktree[activeWorktreeId] ?? [])
          .filter((tab) => isEditorTabContentType(tab.contentType) && !tab.isPinned)
          .map((tab) => tab.id),
      closeTabBarTabs
    )
  }, [activeWorktreeId, closeTabBarTabs, confirmBulkClose])

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
