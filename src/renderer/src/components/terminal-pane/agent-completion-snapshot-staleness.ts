import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

export function isSupersededAgentCompletionSnapshot(
  storedAgentStatus: Pick<AgentStatusEntry, 'state' | 'stateStartedAt'> | undefined,
  snapshot: AgentCompletionStatusSnapshot | undefined
): boolean {
  if (!storedAgentStatus || !snapshot) {
    return false
  }
  const hasStampedTurn =
    typeof snapshot.turnCompletedAt === 'number' && Number.isFinite(snapshot.turnCompletedAt)
  // Why: a stamped background turn carries the agent host's turn-complete clock,
  // which is not the clock the mirrored status row was written from. Only the
  // boundary captured beside that row is comparable to it.
  const comparableStateStartedAt = hasStampedTurn
    ? snapshot.localStateStartedAt
    : (snapshot.localStateStartedAt ?? snapshot.stateStartedAt)
  if (typeof comparableStateStartedAt !== 'number') {
    // Why: a stamped turn boundary is independent evidence that the turn ended, so
    // an unclocked completion must not be guessed stale from a foreign timestamp.
    return hasStampedTurn ? false : storedAgentStatus.state !== snapshot.state
  }
  // Why: hook completion notifications are delayed by a quiet window; by the
  // time they fire, the same pane may already belong to a newer agent turn.
  if (storedAgentStatus.stateStartedAt > comparableStateStartedAt) {
    return true
  }
  return (
    storedAgentStatus.stateStartedAt === comparableStateStartedAt &&
    storedAgentStatus.state !== snapshot.state &&
    !hasStampedTurn
  )
}
