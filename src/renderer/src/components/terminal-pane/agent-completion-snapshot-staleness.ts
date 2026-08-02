import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

export function isSupersededAgentCompletionSnapshot(
  storedAgentStatus: Pick<AgentStatusEntry, 'state' | 'stateStartedAt'> | undefined,
  snapshot: AgentCompletionStatusSnapshot | undefined
): boolean {
  if (!storedAgentStatus || !snapshot) {
    return false
  }
  if (typeof snapshot.stateStartedAt !== 'number') {
    return storedAgentStatus.state !== snapshot.state
  }
  // Why: hook completion notifications are delayed by a quiet window; by the
  // time they fire, the same pane may already belong to a newer agent turn.
  if (storedAgentStatus.stateStartedAt > snapshot.stateStartedAt) {
    return true
  }
  return (
    storedAgentStatus.stateStartedAt === snapshot.stateStartedAt &&
    storedAgentStatus.state !== snapshot.state
  )
}
