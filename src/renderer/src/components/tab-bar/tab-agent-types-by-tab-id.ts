import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'

/**
 * Project `agentStatusByPaneKey` down to the stable `{ terminalTabId: agentType }`
 * the tab strip actually reads (to gate the native-chat view-mode toggle).
 *
 * Why: agent-status pane keys are `${terminalTab.id}:${leafId}` and the tab strip
 * only needs each tab's agent *identity* — which is fixed for the life of the
 * agent. The full `agentStatusByPaneKey` map, however, gets a new top-level
 * identity on every working↔idle status transition app-wide, so subscribing to it
 * whole re-rendered every mounted tab strip on unrelated status churn. Selecting
 * this projection under `useShallow` keeps the result referentially equal across
 * those transitions, so the strip re-renders only when a tab actually gains, loses,
 * or changes its agent.
 *
 * First matching pane per tab wins, mirroring `findTabAgentEntry` exactly (tab ids
 * are colon-free by construction, so the substring before the first `:` is the
 * tab id). A pane whose entry has no `agentType` still claims the tab and yields
 * `null`, identical to `findTabAgentEntry(...)?.agentType ?? null`.
 */
export function selectTabAgentTypesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): Record<string, AgentType> {
  const byTabId: Record<string, AgentType> = {}
  const claimed = new Set<string>()
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const colon = paneKey.indexOf(':')
    if (colon <= 0) {
      continue
    }
    const tabId = paneKey.slice(0, colon)
    if (claimed.has(tabId)) {
      continue
    }
    claimed.add(tabId)
    if (entry.agentType != null) {
      byTabId[tabId] = entry.agentType
    }
  }
  return byTabId
}
