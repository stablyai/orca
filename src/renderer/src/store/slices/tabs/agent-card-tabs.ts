import type { Tab } from '../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'

export const AGENT_CARDS_MAX = 9

/** Agent tabs of a worktree in stable card order: createdAt, then sortOrder, then id. */
export function selectAgentTabs(tabs: readonly Tab[], terminalTabs: readonly TerminalTab[]): Tab[] {
  const agentTerminalTabIds = new Set(
    terminalTabs
      .filter((terminalTab) => terminalTab.launchAgent)
      .map((terminalTab) => terminalTab.id)
  )
  return tabs
    .filter(
      (tab) =>
        tab.contentType === 'agent-session' ||
        (tab.contentType === 'terminal' && agentTerminalTabIds.has(tab.entityId))
    )
    .sort(
      (a, b) => a.createdAt - b.createdAt || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)
    )
}

/** The worktree's single agents container tab, or undefined. Never more than one: the
 *  reconciler creates at most one and prunes extras it finds. */
export function selectAgentsTab(tabs: readonly Tab[]): Tab | undefined {
  return tabs.find((tab) => tab.contentType === 'agents')
}

/** True when every tab in the group is an agent tab (vacuously true when empty). Gates
 *  card-group classification and registry self-heal against a stale or repurposed id. */
export function isAgentOnlyGroup(
  tabOrder: readonly string[],
  agentTabIds: ReadonlySet<string>
): boolean {
  return tabOrder.every((tabId) => agentTabIds.has(tabId))
}

export function isCardedAgentTab(
  state: { agentCardGroupIdsByWorktree: Record<string, readonly string[]> },
  tab: Tab
): boolean {
  return (state.agentCardGroupIdsByWorktree[tab.worktreeId] ?? []).includes(tab.groupId)
}

/** Pane-key prefix for a tab's agent status. A terminal tab's id is the unified tab's entityId. */
export function agentStatusTabIdForTab(tab: Tab): string {
  return tab.contentType === 'terminal' ? tab.entityId : tab.id
}
