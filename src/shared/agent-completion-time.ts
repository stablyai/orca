import type { AgentStateHistoryEntry, AgentStatusEntry } from './agent-status-types'
import { agentTurnStoppedByUser } from './agent-main-agent-verdict'

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
      !agentTurnStoppedByUser(row) &&
      Number.isFinite(row.startedAt) &&
      row.startedAt > max
    ) {
      max = row.startedAt
    }
  }
  return max > 0 ? max : null
}

/**
 * When the entry's agent last actually COMPLETED a turn, or null when nothing qualifies.
 * One clock for both the displayed completion age and Smart Sort's Done eligibility, so a row
 * can't rank as freshly done while showing an age past the staleness threshold.
 *
 * A completion is only:
 *   - a `done` the user did not stop, failures included (its `stateStartedAt` — unmoved by same-state tool/prompt pings); or
 *   - for a session-boundary `done` (connected idle, not a turn), the real completion it displaced.
 */
export function agentEntryCompletionAt(entry: AgentCompletionSource): number | null {
  if (entry.state !== 'done' || agentTurnStoppedByUser(entry)) {
    return null
  }
  if (entry.sessionBoundary === true) {
    return mostRecentCompletedTurnInHistory(entry.stateHistory)
  }
  return Number.isFinite(entry.stateStartedAt) ? entry.stateStartedAt : null
}
