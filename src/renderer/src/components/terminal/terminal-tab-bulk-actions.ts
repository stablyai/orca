import { workspaceCommandAddress } from '@/runtime/workspace-command-address'
import { workspaceAdmittedFiles } from '@/store/workspace-admitted-files'
import {
  hasUnroutableTerminalWorktreeOwner,
  resolveTerminalWorktreeRoute
} from '@/lib/terminal-worktree-route'
import { closeWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { useAppStore } from '@/store'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

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
  state.setActiveTab(tabId)
  const runtimeEnvironmentId = resolveTerminalWorktreeRoute(
    state,
    activeWorktreeId
  )?.runtimeEnvironmentId
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  for (const tab of currentTabs) {
    if (tab.id === tabId || isPinnedVisibleTab(state, activeWorktreeId, tab.id)) {
      continue
    }
    if (closeHostTerminalTabs) {
      // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
      const address = workspaceCommandAddress(state, activeWorktreeId, tab.id)
      closeLocalTerminalTabState(tab.id, { remoteCloseOwnedByHost: true })
      void closeWebRuntimeSessionTab({
        worktreeId: address?.workspaceId ?? activeWorktreeId,
        tabId: address?.tab.id ?? tab.id,
        environmentId: runtimeEnvironmentId,
        reason: 'user'
      })
    } else {
      state.closeTab(tab.id)
    }
  }
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
  const currentEditorFiles = workspaceAdmittedFiles(state, activeWorktreeId)
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
  for (const id of orderedIds.slice(index + 1)) {
    if (isPinnedVisibleTab(state, activeWorktreeId, id)) {
      continue
    }
    if (terminalIdSet.has(id)) {
      if (closeHostTerminalTabs) {
        // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
        const address = workspaceCommandAddress(state, activeWorktreeId, id)
        closeLocalTerminalTabState(id, { remoteCloseOwnedByHost: true })
        void closeWebRuntimeSessionTab({
          worktreeId: address?.workspaceId ?? activeWorktreeId,
          tabId: address?.tab.id ?? id,
          environmentId: runtimeEnvironmentId,
          reason: 'user'
        })
      } else {
        state.closeTab(id)
      }
      continue
    }
    const unifiedTab = (state.unifiedTabsByWorktree?.[activeWorktreeId] ?? []).find(
      (tab) => tab.entityId === id && isEditorTabContentType(tab.contentType)
    )
    if (!unifiedTab?.isPinned) {
      useAppStore.getState().closeFile(id)
    }
  }
}
