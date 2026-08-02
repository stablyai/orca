import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

/** Pick the live agent-status entry for this tab. A tab's panes are keyed
 *  `${tabId}:${leafId}`; the single active agent pane is the one whose paneKey
 *  carries this tab id. (Split-aware resolution refines per-leaf in U8/U9; the
 *  view today resolves the tab's agent pane.)
 *
 *  Lives in its own module so the #19 selector (`useShallow(findTabAgentEntry)`)
 *  is unit-testable without importing the store-coupled view component. */
export function findTabAgentEntry(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  terminalTabId: string
): AgentStatusEntry | undefined {
  const prefix = `${terminalTabId}:`
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    if (paneKey.startsWith(prefix)) {
      return entry
    }
  }
  return undefined
}
