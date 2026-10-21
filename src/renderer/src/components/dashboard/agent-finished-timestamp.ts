import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import {
  agentTurnEndedOnPurpose,
  agentVerdictDisplayMark
} from '../../../../shared/agent-main-agent-verdict'
import type { DashboardAgentRow } from './useDashboardData'

/**
 * The moment an agent last entered `done`, or null if it never finished (still
 * working / idle without a prior completion). Shared by the left worktree
 * sidebar and the pop-out dashboard so both time from the SAME event: a finished
 * agent reads "N since it finished", an active one falls through to its start.
 */
export function lastEnteredDoneAt(
  agent: Pick<DashboardAgentRow, 'rowSource' | 'state' | 'entry' | 'childRow'>
): number | null {
  // Why: a subagent has no turns; it ended when its host settled it, if it has.
  if (agent.rowSource === 'subagent') {
    return agent.childRow?.settledAt ?? null
  }
  const entry = agent.entry
  // Why: same primitive Smart Sort ranks on, so the displayed age and Done eligibility share a clock.
  // (Session-boundary `done` means the session connected idle — STA-3386 — so it resolves to the real
  // completion it displaced, if any.)
  const completedAt = agentEntryCompletionAt(entry)
  if (completedAt !== null) {
    return completedAt
  }
  // Why: display is looser than ranking — a stopped turn still shows when it ended.
  if (entry.state === 'done' && agentTurnEndedOnPurpose(entry) && entry.sessionBoundary !== true) {
    return entry.stateStartedAt
  }
  // Why: a failed main agent reads failed while its subagents run, so it shows when it failed.
  if (entry.state !== 'done' && entry.mainAgent && agentVerdictDisplayMark(entry) === 'failed') {
    return entry.mainAgent.stateStartedAt
  }
  for (let i = (entry.stateHistory?.length ?? 0) - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}
