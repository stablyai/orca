import {
  hasUnroutableTerminalWorktreeOwner,
  resolveTerminalWorktreeRoute
} from '@/lib/terminal-worktree-route'
import { closeWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { useAppStore } from '@/store'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'

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
      closeLocalTerminalTabState(tab.id, { remoteCloseOwnedByHost: true })
      void closeWebRuntimeSessionTab({
        worktreeId: activeWorktreeId,
        tabId: tab.id,
        environmentId: runtimeEnvironmentId,
        reason: 'user'
      })
    } else {
      state.closeTab(tab.id)
    }
  }
}
