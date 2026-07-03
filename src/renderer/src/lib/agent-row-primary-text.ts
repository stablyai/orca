import type { AgentStatusEntry } from '../../../shared/agent-status-types'

export function getAgentRowPrimaryText(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): string {
  return (
    entry.orchestration?.displayName?.trim() ||
    entry.orchestration?.taskTitle?.trim() ||
    entry.prompt.trim()
  )
}
