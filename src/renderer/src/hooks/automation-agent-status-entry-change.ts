import type { AgentStateHistoryEntry, AgentStatusEntry } from '../../../shared/agent-status-types'

export const UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY = Symbol('unchanged-agent-status-entry')

export function selectAutomationAgentStatusEntryChange(
  entries: Readonly<Record<string, AgentStatusEntry>>,
  targetPaneKey: string,
  previousEntry: AgentStatusEntry | undefined
): AgentStatusEntry | undefined | typeof UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY {
  const entry = Object.prototype.propertyIsEnumerable.call(entries, targetPaneKey)
    ? entries[targetPaneKey]
    : undefined
  // Why: status writes replace entries; unchanged identity proves an unrelated publication.
  return entry === previousEntry ? UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY : entry
}

function agentStateHistoryEntriesEqual(
  left: AgentStateHistoryEntry,
  right: AgentStateHistoryEntry
): boolean {
  return (
    left.state === right.state &&
    left.prompt === right.prompt &&
    left.startedAt === right.startedAt &&
    left.interrupted === right.interrupted
  )
}

export function getAgentStateHistoryOverlap(
  previous: AgentStateHistoryEntry[],
  current: AgentStateHistoryEntry[]
): number {
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    const previousOffset = previous.length - overlap
    if (
      current
        .slice(0, overlap)
        .every((entry, index) =>
          agentStateHistoryEntriesEqual(entry, previous[previousOffset + index])
        )
    ) {
      return overlap
    }
  }
  return 0
}
