import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

export function isSupersededAgentCompletionSnapshot(
  storedAgentStatus: Pick<AgentStatusEntry, 'state' | 'stateStartedAt'> | undefined,
  snapshot: AgentCompletionStatusSnapshot | undefined
): boolean {
  if (!storedAgentStatus || !snapshot) {
    return false
  }
  const comparableStateStartedAt = snapshot.localStateStartedAt ?? snapshot.stateStartedAt
  if (typeof comparableStateStartedAt !== 'number') {
    return storedAgentStatus.state !== snapshot.state
  }
  // Why: hook completion notifications are delayed by a quiet window; by the
  // time they fire, the same pane may already belong to a newer agent turn.
  if (storedAgentStatus.stateStartedAt > comparableStateStartedAt) {
    return true
  }
  const hasStampedTurn =
    typeof snapshot.turnCompletedAt === 'number' && Number.isFinite(snapshot.turnCompletedAt)
  return (
    storedAgentStatus.stateStartedAt === comparableStateStartedAt &&
    storedAgentStatus.state !== snapshot.state &&
    !hasStampedTurn
  )
}
