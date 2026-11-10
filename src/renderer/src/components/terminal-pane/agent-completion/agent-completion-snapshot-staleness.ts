import { completionHistoryContains } from '../../../../../shared/agent-status/lifecycle/agent-completion-history'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

export function isSupersededAgentCompletionSnapshot(
  storedAgentStatus:
    | (Pick<AgentStatusEntry, 'state' | 'stateStartedAt' | 'turnEndedAt'> &
        Partial<Pick<AgentStatusEntry, 'stateHistory' | 'sessionBoundary' | 'agentType'>>)
    | undefined,
  snapshot: AgentCompletionStatusSnapshot | undefined
): boolean {
  if (!storedAgentStatus || !snapshot) {
    return false
  }
  if (
    storedAgentStatus.sessionBoundary &&
    storedAgentStatus.stateHistory &&
    storedAgentStatus.agentType === snapshot.agentType &&
    completionHistoryContains({ stateHistory: storedAgentStatus.stateHistory }, snapshot)
  ) {
    return false
  }
  const comparableStateStartedAt = snapshot.localStateStartedAt ?? snapshot.stateStartedAt
  if (typeof comparableStateStartedAt !== 'number') {
    return storedAgentStatus.state !== snapshot.state
  }
  // Quiet-window delays can outlive the observed turn; reject snapshots after newer pane activity.
  if (storedAgentStatus.stateStartedAt > comparableStateStartedAt) {
    return true
  }
  const hasStampedTurn =
    typeof snapshot.turnCompletedAt === 'number' && Number.isFinite(snapshot.turnCompletedAt)
  if (storedAgentStatus.stateStartedAt !== comparableStateStartedAt) {
    return false
  }
  // Why: within one done segment, a later host turn end supersedes the delayed earlier one.
  return storedAgentStatus.state !== snapshot.state
    ? !hasStampedTurn
    : snapshot.turnEndedAt !== undefined &&
        (storedAgentStatus.turnEndedAt ?? 0) > snapshot.turnEndedAt
}
