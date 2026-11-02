import type { AgentStatusEntry } from '../../../shared/agent-status-types'

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
