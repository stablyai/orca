import { AGENT_STATUS_STALE_AFTER_MS, type AgentStatusEntry } from '../agent-status-types'
import { isAgentStatusFresh } from '../agent-status-freshness'
import { agentEntryCompletionAt } from '../agent-completion-time'

/** Whether a pane's new row can move it in the Smart order, so the sort's settle window restarts. */
export function isSmartSortRelevantAgentChange(
  existing: AgentStatusEntry | undefined,
  entry: AgentStatusEntry,
  updatedAt: number
): boolean {
  if (!existing || existing.state !== entry.state) {
    return true
  }
  return (
    !isAgentStatusFresh(existing, updatedAt, AGENT_STATUS_STALE_AFTER_MS) ||
    existing.worktreeId !== entry.worktreeId ||
    existing.tabId !== entry.tabId ||
    entry.stateStartedAt !== existing.stateStartedAt ||
    (entry.state === 'done' && agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry))
  )
}
