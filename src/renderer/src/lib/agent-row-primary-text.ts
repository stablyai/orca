import type { AgentStatusEntry } from '../../../shared/agent-status-types'

export function getAgentRowPrimaryText(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt' | 'customAgentLabel'>
): string {
  // Why: an explicit user-set CLI label is a deliberate override and must win
  // over every auto-derived label, including orchestration-assigned ones.
  return (
    entry.customAgentLabel?.trim() ||
    entry.orchestration?.displayName?.trim() ||
    entry.orchestration?.taskTitle?.trim() ||
    entry.prompt.trim()
  )
}
