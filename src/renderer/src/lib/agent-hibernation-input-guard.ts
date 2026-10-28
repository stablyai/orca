import type { AgentStatusEntry } from '../../../shared/agent-status-types'

export function lastInputBlocksHibernation(entry: AgentStatusEntry, inputAt: number): boolean {
  // Working-segment input and the open done tail may contain drafts; waiting/blocked or completed done-segment input was consumed. Check history too, and resolve boundary ties toward keeping the PTY alive.
  if (inputAt >= entry.stateStartedAt) {
    if (entry.state === 'working' || entry.state === 'done') {
      return true
    }
    if (inputAt > entry.stateStartedAt) {
      return false
    }
  }
  for (let i = entry.stateHistory.length - 1; i >= 0; i--) {
    const past = entry.stateHistory[i]
    if (!past || inputAt < past.startedAt) {
      continue
    }
    if (past.state === 'working') {
      return true
    }
    if (inputAt > past.startedAt) {
      return false
    }
  }
  return false
}
