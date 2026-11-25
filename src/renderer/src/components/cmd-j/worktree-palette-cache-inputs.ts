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
  // Closed palettes stay mounted; ignore Checks cache churn while their results are invisible.
  if (!active) {
    return EMPTY_WORKTREE_PALETTE_CACHE_INPUTS
  }
  return {
    prCache: state.prCache,
    issueCache: state.issueCache,
    hostedReviewCache: state.hostedReviewCache
  }
}
