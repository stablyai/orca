import type { DashboardAgentRow } from './useDashboardData'

/**
 * The moment an agent last entered `done`, or null if it never finished (still
 * working / idle without a prior completion). Shared by the left worktree
 * sidebar and the pop-out dashboard so both time from the SAME event: a finished
 * agent reads "N since it finished", an active one falls through to its start.
 */
export function lastEnteredDoneAt(
  agent: Pick<DashboardAgentRow, 'rowSource' | 'state' | 'entry'>
): number | null {
  // Why: idle subagent child rows are alive-but-idle (teammates persist
  // between turns), not finished — fall through to the started-at timestamp.
  if (agent.rowSource === 'subagent' && agent.state === 'idle') {
    return null
  }
  const entry = agent.entry
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  for (let i = (entry.stateHistory?.length ?? 0) - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}
