import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionOwnerForTab
} from '@/runtime/structured-agent-session-owner'
import { createKeptWorktreeSurfacePruners } from '@/store/slices/tabs/kept-worktree-surface-pruning'

export function retireMovedSessionPlacement(
  sessionId: string,
  oldWorkspace: string,
  currentWorkspace: string,
  host: RuntimeClientTarget
): void {
  if (currentWorkspace !== oldWorkspace) {
    const state = useAppStore.getState()
    const ids = new Set(
      (state.unifiedTabsByWorktree[oldWorkspace] ?? [])
        .filter(
          (tab) =>
            tab.contentType === 'agent-session' &&
            tab.entityId === sessionId &&
            structuredAgentSessionOwnerForTab(state, tab) ===
              executionHostIdForStructuredTarget(host)
        )
        .map((tab) => tab.id)
    )
    if (ids.size) {
      const prune = createKeptWorktreeSurfacePruners(state, {
        worktreeIds: new Set([oldWorkspace]),
        unifiedTabIds: ids,
        terminalTabIds: new Set(),
        fileIds: new Set(),
        browserTabIds: new Set()
      })
      useAppStore.setState({
        unifiedTabsByWorktree: prune.unifiedTabs(state.unifiedTabsByWorktree),
        groupsByWorktree: prune.groups(state.groupsByWorktree),
        tabBarOrderByWorktree: prune.tabBarOrder(state.tabBarOrderByWorktree)
      })
    }
  }
}
