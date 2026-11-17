/** Keep settled sidebar sortEpoch in store: React effect mirroring nested burst flushSync updates into React #185. Store listener covers slice/runtime writes even without mounted components. */
import type { StoreApi } from 'zustand'
import {
  INITIAL_SORT_SETTLE_STATE,
  reduceSortSettle,
  type SortSettleEvent
} from '../../../../../shared/sidebar-list/sorting/sort-settle'
import type { AppState } from '../../types'
import { getIndexedAllWorktrees } from '../worktrees/listing/worktree-catalog-index'
import { replacedWorktreeRows } from '../worktrees/listing/worktree-catalog-membership'
import { selectWorktreesByRepo } from '../../workspaces/catalog/workspace-record-fields'

function countLiveWorktrees(worktreesByRepo: AppState['worktreesByRepo']): number {
  let count = 0
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived) {
      count++
    }
  }
  return count
}

/** Live-row counter for sort settling; a title-only write reuses the last count instead of rescanning every row. */
export function createLiveWorktreeCounter(): (
  worktreesByRepo: AppState['worktreesByRepo']
) => number {
  // Weak so the counter never keeps a replaced catalog alive.
  let counted: WeakRef<AppState['worktreesByRepo']> | null = null
  let count = 0
  return (worktreesByRepo) => {
    const previous = counted?.deref()
    if (!previous || replacedWorktreeRows(worktreesByRepo, previous) === null) {
      count = countLiveWorktrees(worktreesByRepo)
    }
    counted = new WeakRef(worktreesByRepo)
    return count
  }
}

/** Call once from inside the store's state creator, passing its `api`. */
export function installSettledSortEpoch(
  api: Pick<StoreApi<AppState>, 'setState' | 'subscribe'>
): void {
  let settleState = INITIAL_SORT_SETTLE_STATE
  const countLive = createLiveWorktreeCounter()
  let timer: ReturnType<typeof setTimeout> | undefined

  const dispatch = (event: SortSettleEvent): void => {
    const now = Date.now()
    const step = reduceSortSettle(settleState, event, now)
    // Why: the timer mirrors the reducer's deadline, re-armed only when it moves.
    if (step.state.deadline !== settleState.deadline) {
      clearTimeout(timer)
      if (step.state.deadline !== null) {
        timer = setTimeout(() => dispatch({ kind: 'deadline' }), step.state.deadline - now)
      }
    }
    settleState = step.state
    if (step.settle) {
      api.setState((s) => ({ settledSortEpoch: s.sortEpoch }))
    }
  }

  api.subscribe((state, previous) => {
    const epochBumped = state.sortEpoch !== previous.sortEpoch
    // Why also on row writes: a bump-less add during a pending window must still settle now.
    const rowsChanged = selectWorktreesByRepo(state) !== selectWorktreesByRepo(previous)
    dispatch({
      kind: 'write',
      change:
        epochBumped || rowsChanged
          ? { epochBumped, liveCount: countLive(selectWorktreesByRepo(state)) }
          : null,
      settled: state.settledSortEpoch === state.sortEpoch,
      sortBy: state.sortBy,
      previousSortBy: previous.sortBy
    })
  })
}
