import type { AgentStatusEntry } from './agent-status-types'

/** The subset of a hook entry a session start is derived from. */
export type AgentSessionStartSource = Pick<
  AgentStatusEntry,
  'firstStateStartedAt' | 'stateStartedAt' | 'stateHistory'
>

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * When this pane's agent session first reported a state — the stable identity clock the
 * sidebar orders agent rows by.
 *
 * Why not `stateHistory[0].startedAt` alone: `stateHistory` is a rolling window capped at
 * `AGENT_STATE_HISTORY_MAX` that trims oldest-first, so once a session passes the cap its
 * first *retained* row advances on every transition. Reading it directly turns a stable
 * identity clock into an activity clock, and the row re-sorts on each new turn.
 * `firstStateStartedAt` is latched at session start and never moves; history remains the
 * fallback for entries that predate it (rehydrated from disk, derived rows).
 */
export function agentEntrySessionStartedAt(entry: AgentSessionStartSource): number {
  return (
    finiteOrNull(entry.firstStateStartedAt) ??
    finiteOrNull(entry.stateHistory[0]?.startedAt) ??
    entry.stateStartedAt
  )
}
