import { selectAgentTabs } from './agent-card-tabs'
import type { TabsSlice, TabsSliceGet } from './tabs-slice-contract'

/** How many agents the worktree's Agents tab is currently hosting. */
export function countWorktreeAgentTabs(get: TabsSliceGet, worktreeId: string): number {
  return selectAgentTabs(
    get().unifiedTabsByWorktree[worktreeId] ?? [],
    get().tabsByWorktree[worktreeId] ?? []
  ).length
}

export function createTabsAgentCardsTeardownActions(
  get: TabsSliceGet
): Pick<TabsSlice, 'closeAllAgentCards'> {
  return {
    /**
     * Closes every agent the Agents tab hosts, and returns how many were closed.
     *
     * Why this exists rather than closing the Agents tab itself: the tab is only the agents'
     * host. While a single agent is still alive the reconciler rebuilds the tab immediately, so
     * closing the tab alone reads to the user as nothing happening at all.
     */
    closeAllAgentCards: (worktreeId) => {
      const agentTabs = selectAgentTabs(
        get().unifiedTabsByWorktree[worktreeId] ?? [],
        get().tabsByWorktree[worktreeId] ?? []
      )
      for (const tab of agentTabs) {
        get().closeUnifiedTab(tab.id)
      }
      // The Agents tab, its card groups and the registry are all torn down by the reconciler
      // once the last agent is gone, which is the same path a one-by-one close takes.
      get().syncAgentCards(worktreeId)
      return agentTabs.length
    }
  }
}
