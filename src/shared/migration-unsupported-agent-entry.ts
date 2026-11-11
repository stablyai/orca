import type { AgentStatusEntry } from './agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from './agent-status/contracts/agent-status-ipc-payload'

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
        // Keep persistent migration blocks fresh without Date.now so snapshot selectors can cache stable objects.
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
