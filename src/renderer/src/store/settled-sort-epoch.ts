/**
 * Maintains `settledSortEpoch`: the sortEpoch the sidebar sort actually reads.
 *
 * Why in the store: the sidebar used to mirror sortEpoch into React state from an
 * effect, adding a nested update per bump; bursts of flushSync bumps stacked those
 * into "Maximum update depth exceeded" (React #185). A store listener sees every
 * write path — slice actions and runtime patches such as the web session sync — so
 * the settled value stays correct without any component mounted.
 */
import type { StoreApi } from 'zustand'
import type { AppState } from './types'
import { getIndexedAllWorktrees } from './worktree-repo-index'

// Why: time-decaying scores would make rows jump on every bump; coalesce a burst into one re-sort.
export const SORT_SETTLE_MS = 3_000

function countLiveWorktrees(worktreesByRepo: AppState['worktreesByRepo']): number {
  let count = 0
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived) {
      count++
    }
  }
  return count
}

/** Call once from inside the store's state creator, passing its `api`. */
export function installSettledSortEpoch(
  api: Pick<StoreApi<AppState>, 'setState' | 'subscribe'>
): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Why a baseline from the last bump (not the previous write): a row change that skipped
  // its bump (stale-host purge) must not re-sort on its own.
  let liveWorktreeCountAtLastBump = 0

  const settle = (): void => api.setState((s) => ({ settledSortEpoch: s.sortEpoch }))

  api.subscribe((state, previous) => {
    const epochChanged = state.sortEpoch !== previous.sortEpoch
    let structuralChange = false
    // Why also on row writes: a bump-less add during a pending window must still settle now.
    if (epochChanged || state.worktreesByRepo !== previous.worktreesByRepo) {
      const count = countLiveWorktrees(state.worktreesByRepo)
      structuralChange = count !== liveWorktreeCountAtLastBump
      if (epochChanged) {
        liveWorktreeCountAtLastBump = count
      }
    }
    if (state.settledSortEpoch === state.sortEpoch) {
      // Why: any write that lands settled — settle() itself or a store reset — retires the pending timer.
      clearTimeout(timer)
      return
    }
    // Why: adds/removes, Manual (direct manipulation), and a mode switch never wait out the window.
    if (structuralChange || state.sortBy === 'manual' || state.sortBy !== previous.sortBy) {
      settle()
      return
    }
    if (epochChanged) {
      clearTimeout(timer)
      timer = setTimeout(settle, SORT_SETTLE_MS)
    }
  })
}
