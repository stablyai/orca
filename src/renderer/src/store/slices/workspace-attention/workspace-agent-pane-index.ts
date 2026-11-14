import type { AppState } from '../../types'
import { resolveAgentStatusWorktreeId } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { workspaceMarkerTabs } from './workspace-live-markers'

let terminalTabs: AppState['tabsByWorktree'] | null = null
let unifiedTabs: AppState['unifiedTabsByWorktree'] | null = null
const tabOwners = new Map<string, string>()

/** Explicit reads include completed orphans and parent-attributed panes, even without a sidebar row. */
export function workspaceAgentPaneKeys(state: AppState, worktreeId: string): string[] {
  const tabsChanged =
    terminalTabs !== state.tabsByWorktree || unifiedTabs !== state.unifiedTabsByWorktree
  if (tabsChanged) {
    tabOwners.clear()
    for (const id of new Set([
      ...Object.keys(state.tabsByWorktree),
      ...Object.keys(state.unifiedTabsByWorktree)
    ])) {
      for (const tab of workspaceMarkerTabs(state, id)) {
        tabOwners.set(tab.id, id)
      }
    }
    terminalTabs = state.tabsByWorktree
    unifiedTabs = state.unifiedTabsByWorktree
  }
  // Why a walk: explicit reads are user actions over the capped accepted rows, not status updates.
  const keys: string[] = []
  for (const [paneKey, entry] of state.agentStatusByPaneKey) {
    if (resolveAgentStatusWorktreeId(entry, tabOwners) === worktreeId) {
      keys.push(paneKey)
    }
  }
  return keys
}
