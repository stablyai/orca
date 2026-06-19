import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../shared/agent-status-types'

const cachedMigrationUnsupportedEntries = new WeakMap<
  MigrationUnsupportedPtyEntry,
  AgentStatusEntry | null
>()

export function migrationUnsupportedToAgentStatusEntry(
  entry: MigrationUnsupportedPtyEntry
): AgentStatusEntry | null {
  const cached = cachedMigrationUnsupportedEntries.get(entry)
  if (cached !== undefined) {
    return cached
  }

  const converted: AgentStatusEntry | null = !entry.paneKey
    ? null
    : {
        state: 'blocked',
        prompt: 'Agent unavailable after pane identity migration',
        // Why: this synthetic row represents a persistent migration block. Keep
        // it "fresh" without Date.now() so Zustand selectors can return a stable
        // cached object for the same store snapshot.
        updatedAt: Number.MAX_SAFE_INTEGER,
        stateStartedAt: entry.updatedAt,
        agentType: 'unknown',
        paneKey: entry.paneKey,
        terminalTitle: 'Migration unsupported',
        stateHistory: [],
        lastAssistantMessage:
          'Restart this terminal so Orca can attach a stable UUID pane key to agent hooks.'
      }

  cachedMigrationUnsupportedEntries.set(entry, converted)
  return converted
}
