import type { AppState } from '@/store/types'

export type WorktreePaletteCacheInputs = {
  prCache: AppState['prCache'] | null
  issueCache: AppState['issueCache'] | null
  hostedReviewCache: AppState['hostedReviewCache'] | null
}

export const EMPTY_WORKTREE_PALETTE_CACHE_INPUTS: WorktreePaletteCacheInputs = Object.freeze({
  prCache: null,
  issueCache: null,
  hostedReviewCache: null
})

export function selectWorktreePaletteCacheInputs(
  state: Pick<AppState, 'prCache' | 'issueCache' | 'hostedReviewCache'>,
  active: boolean
): WorktreePaletteCacheInputs {
  // Why: the palette stays mounted while closed; cache replacement from Checks
  // must not rerender it when no search results are visible.
  if (!active) {
    return EMPTY_WORKTREE_PALETTE_CACHE_INPUTS
  }
  return {
    prCache: state.prCache,
    issueCache: state.issueCache,
    hostedReviewCache: state.hostedReviewCache
  }
}
