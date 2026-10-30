import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

/** Return the first status entry under the tabId: prefix; callers needing the active split must resolve its leaf. */
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
