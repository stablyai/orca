import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

/** Return the first status entry under the tabId: prefix; callers needing the active split must resolve its leaf. */
export function findTabAgentEntry(
  agentStatusByPaneKey: ReadonlyMap<string, AgentStatusEntry>,
  terminalTabId: string
): AgentStatusEntry | undefined {
  const prefix = `${terminalTabId}:`
  for (const [paneKey, entry] of Array.from(agentStatusByPaneKey.entries())) {
    if (paneKey.startsWith(prefix)) {
      return entry
    }
  }
  return undefined
}
