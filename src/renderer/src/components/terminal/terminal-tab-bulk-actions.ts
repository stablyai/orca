import type { TabContentType } from '../../../../shared/tab-types'
import {
  hasUnroutableTerminalWorktreeOwner,
  resolveTerminalWorktreeRoute
} from '@/lib/terminal-worktree-route'
import { closeWebRuntimeSessionTab, isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'
import { collectBulkTerminalTabIds, guardBulkTerminalClose } from './bulk-terminal-close-guard'

const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

type TerminalTabBulkActionState = ReturnType<typeof useAppStore.getState>

function isPinnedVisibleTab(
  state: TerminalTabBulkActionState,
  worktreeId: string,
  visibleId: string
): boolean {
  return (
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
    ) ?? false
  )
}

export function closeOtherTerminalTabs(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  const currentTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  const closableIds = currentTabs
    .map((tab) => tab.id)
    .filter((id) => id !== tabId && !isPinnedVisibleTab(state, activeWorktreeId, id))
  // Why: activate and close only once the aggregated running-process prompt is answered, so
  // cancelling leaves both the tab strip and the running work untouched.
  const performClose = (): void => {
    const latest = useAppStore.getState()
    latest.setActiveTab(tabId)
    const runtimeEnvironmentId = resolveTerminalWorktreeRoute(
      latest,
      activeWorktreeId
    )?.runtimeEnvironmentId
    const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
    for (const id of closableIds) {
      if (closeHostTerminalTabs) {
        // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
        closeLocalTerminalTabState(id, { remoteCloseOwnedByHost: true })
        void closeWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId: id,
          environmentId: runtimeEnvironmentId,
          reason: 'user'
        })
      } else {
        latest.closeTab(id)
      }
    }
  }
  guardBulkTerminalClose({
    worktreeId: activeWorktreeId,
    terminalTabIds: collectBulkTerminalTabIds(state, activeWorktreeId, closableIds),
    revealTab: (terminalTabId) => useAppStore.getState().setActiveTab(terminalTabId),
    onProceed: performClose
  })
}

export function closeTerminalTabsToRight(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }

  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  const currentTerminalTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  const currentEditorFiles = state.openFiles.filter((file) => file.worktreeId === activeWorktreeId)
  const runtimeEnvironmentId = resolveTerminalWorktreeRoute(
    state,
    activeWorktreeId
  )?.runtimeEnvironmentId
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  const terminalIds = currentTerminalTabs.map((tab) => tab.id)
  const terminalIdSet = new Set(terminalIds)
  const orderedIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[activeWorktreeId],
    terminalIds,
    currentEditorFiles.map((file) => file.id)
  )

  const index = orderedIds.indexOf(tabId)
  if (index === -1) {
    return
  }
  const closableIds = orderedIds
    .slice(index + 1)
    .filter((id) => !isPinnedVisibleTab(state, activeWorktreeId, id))
  const performClose = (): void => {
    for (const id of closableIds) {
      if (terminalIdSet.has(id)) {
        if (closeHostTerminalTabs) {
          // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
          closeLocalTerminalTabState(id, { remoteCloseOwnedByHost: true })
          void closeWebRuntimeSessionTab({
            worktreeId: activeWorktreeId,
            tabId: id,
            environmentId: runtimeEnvironmentId,
            reason: 'user'
          })
        } else {
          useAppStore.getState().closeTab(id)
        }
        continue
      }
      const unifiedTab = (
        useAppStore.getState().unifiedTabsByWorktree?.[activeWorktreeId] ?? []
      ).find((tab) => tab.entityId === id && EDITOR_TAB_CONTENT_TYPES.has(tab.contentType))
      if (!unifiedTab?.isPinned) {
        useAppStore.getState().closeFile(id)
      }
    }
  }
  guardBulkTerminalClose({
    worktreeId: activeWorktreeId,
    terminalTabIds: closableIds.filter((id) => terminalIdSet.has(id)),
    revealTab: (terminalTabId) => useAppStore.getState().setActiveTab(terminalTabId),
    onProceed: performClose
  })
}
