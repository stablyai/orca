import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../shared/agent-status-types'

export function migrationUnsupportedToAgentStatusEntry(
  entry: MigrationUnsupportedPtyEntry
): AgentStatusEntry | null {
  if (!entry.paneKey) {
    return null
  }
  const now = Date.now()
  return {
    state: 'blocked',
    prompt: 'Agent unavailable after pane identity migration',
    // Why: this is a persistent migration block, not a hook heartbeat. Keep it
    // fresh while present so normal stale-status decay does not hide it.
    updatedAt: Math.max(entry.updatedAt, now),
    stateStartedAt: entry.updatedAt,
    agentType: 'unknown',
    paneKey: entry.paneKey,
    terminalTitle: 'Migration unsupported',
    stateHistory: [],
    lastAssistantMessage:
      'Restart this terminal so Orca can attach a stable UUID pane key to agent hooks.'
  }
}
