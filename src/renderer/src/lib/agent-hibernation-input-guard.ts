import type { AgentStatusEntry } from '../../../shared/agent-status-types'

export function lastInputBlocksHibernation(entry: AgentStatusEntry, inputAt: number): boolean {
  // Why: attribute the last real input to the state segment it landed in —
  // stateHistory entries in order, then the current state as the open tail.
  // Input during any 'working' segment is a draft or queued message, and
  // input in the open 'done' tail is post-completion engagement; both die
  // with the PTY, so they block. Input during input-expecting states
  // ('waiting', 'blocked') or in a done segment that later transitioned
  // onward was consumed as a submission and must not block — otherwise every
  // session with a mid-turn permission answer would never hibernate.
  // Ties (input stamped the same millisecond as a segment start) resolve
  // toward blocking: when the input could belong to either neighbor, prefer
  // keeping the pane alive over risking a lost draft.
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
  // Input older than all recorded segments predates anything still at risk.
  return false
}
