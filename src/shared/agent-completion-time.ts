import type { AgentStateHistoryEntry, AgentStatusEntry } from './agent-status-types'
import { agentTurnEndedOnPurpose } from './agent-main-agent-verdict'

/** The subset of a hook entry a completion time is derived from. */
export type AgentCompletionSource = Pick<
  AgentStatusEntry,
  'state' | 'stateStartedAt' | 'stateHistory' | 'interrupted' | 'mainAgent' | 'sessionBoundary'
>

function mostRecentCompletedTurnInHistory(
  history: readonly AgentStateHistoryEntry[] | undefined
): number | null {
  let max = 0
  for (const row of history ?? []) {
    if (
      row.state === 'done' &&
      !agentTurnEndedOnPurpose(row) &&
      Number.isFinite(row.startedAt) &&
      row.startedAt > max
    ) {
      max = row.startedAt
    }
  }
  return max > 0 ? max : null
}

/** Share completion age and Smart Sort eligibility. Count non-user-stopped done turns (including failures), or the real completion displaced by a session boundary; same-state pings must not refresh it. */
export function agentEntryCompletionAt(entry: AgentCompletionSource): number | null {
  if (entry.state !== 'done' || agentTurnEndedOnPurpose(entry)) {
    return null
  }
  if (entry.sessionBoundary === true) {
    return mostRecentCompletedTurnInHistory(entry.stateHistory)
  }
  return Number.isFinite(entry.stateStartedAt) ? entry.stateStartedAt : null
}
