import type { Tab } from '../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { selectAgentTabs } from './agent-card-tabs'
import type { TabsSlice, TabsSliceGet } from './tabs-slice-contract'

/** The state this module reads, kept structural so it works for both a store getter and a snapshot. */
export type HostedAgentTabsState = {
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>
  agentCardGroupIdsByWorktree: Readonly<Record<string, readonly string[]>>
}

/**
 * The agents the Agents tab actually hosts, which is not every agent in the worktree.
 *
 * Why the registry filter: past `AGENT_CARDS_MAX` the overflow agents stay ordinary top-level
 * tabs. Counting them would overstate the confirmation, and closing them would end sessions the
 * user never saw inside the tab they asked to close.
 */
export function selectHostedAgentTabs(
  state: HostedAgentTabsState,
  worktreeId: string
): readonly Tab[] {
  // Optional reads: these maps are absent until a worktree hydrates, and callers reach here
  // from close paths that can run during that window.
  const cardGroupIds = new Set(state.agentCardGroupIdsByWorktree?.[worktreeId] ?? [])
  if (cardGroupIds.size === 0) {
    return []
  }
  return selectAgentTabs(
    state.unifiedTabsByWorktree?.[worktreeId] ?? [],
    state.tabsByWorktree?.[worktreeId] ?? []
  ).filter((tab) => cardGroupIds.has(tab.groupId))
}

/** How many agents the worktree's Agents tab is currently hosting. */
export function countHostedAgentTabs(state: HostedAgentTabsState, worktreeId: string): number {
  return selectHostedAgentTabs(state, worktreeId).length
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
      const agentTabs = selectHostedAgentTabs(get(), worktreeId)
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
