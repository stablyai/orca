import type { WorkspaceSortBy } from '../workspace-view/workspace-row-sort'

// Why: time-decaying scores would make rows jump on every bump; coalesce a burst into one re-sort.
export const SORT_SETTLE_MS = 3_000

export type SortSettleState = {
  /** Why from the last bump (not the previous write): a row change that skipped its bump (stale-host purge) must not re-sort on its own. */
  liveCountAtLastBump: number
  /** When the pending burst settles; null when nothing is pending. */
  deadline: number | null
}

export type SortSettleEvent =
  | {
      kind: 'write'
      /** Null when the write changed neither sortEpoch nor the rows. */
      change: { epochBumped: boolean; liveCount: number } | null
      /** The write already lands settled: settling itself, or a store reset. */
      settled: boolean
      sortBy: WorkspaceSortBy
      previousSortBy: WorkspaceSortBy
    }
  | { kind: 'deadline' }

export type SortSettleStep = { state: SortSettleState; settle: boolean }

export const INITIAL_SORT_SETTLE_STATE: SortSettleState = { liveCountAtLastBump: 0, deadline: null }

export function reduceSortSettle(
  state: SortSettleState,
  event: SortSettleEvent,
  now: number
): SortSettleStep {
  if (event.kind === 'deadline') {
    return { state: { ...state, deadline: null }, settle: state.deadline !== null }
  }
  const { change } = event
  const structuralChange = change !== null && change.liveCount !== state.liveCountAtLastBump
  const liveCountAtLastBump = change?.epochBumped ? change.liveCount : state.liveCountAtLastBump
  if (event.settled) {
    return { state: { liveCountAtLastBump, deadline: null }, settle: false }
  }
  // Why: adds/removes, Manual (direct manipulation), and a mode switch never wait out the window.
  if (structuralChange || event.sortBy === 'manual' || event.sortBy !== event.previousSortBy) {
    return { state: { liveCountAtLastBump, deadline: null }, settle: true }
  }
  const deadline = change?.epochBumped ? now + SORT_SETTLE_MS : state.deadline
  return { state: { liveCountAtLastBump, deadline }, settle: false }
}
