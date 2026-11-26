import type { AgentStatusIpcPayload } from './contracts/agent-status-ipc-payload'

/** The newest row each pane's agent published; a restored or session-only row is not live evidence. */
export function latestLiveAgentStatusRowsByPaneKey(
  rows: readonly AgentStatusIpcPayload[]
): Map<string, AgentStatusIpcPayload> {
  const latest = new Map<string, AgentStatusIpcPayload>()
  for (const row of rows) {
    if (row.restoredUnconfirmed === true || row.providerSessionOnly === true) {
      continue
    }
    const current = latest.get(row.paneKey)
    if (!current || row.receivedAt > current.receivedAt) {
      latest.set(row.paneKey, row)
    }
  }
  return latest
}
