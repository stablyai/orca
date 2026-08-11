import type { AppState } from '@/store/types'
import type { WorktreeCardProperty } from '../../../../shared/types'
import type { WorktreeGroupBy } from './worktree-list-groups'

export type WorktreeListReviewCacheState = Pick<
  AppState,
  'folderWorkspaces' | 'hostedReviewCache' | 'prCache' | 'settings'
>

export type WorktreeListReviewCacheInputs = {
  prCache: AppState['prCache'] | null
  hostedReviewCache: AppState['hostedReviewCache'] | null
}

export const EMPTY_WORKTREE_LIST_REVIEW_CACHE_INPUTS: WorktreeListReviewCacheInputs = Object.freeze(
  {
    prCache: null,
    hostedReviewCache: null
  }
)

export function selectWorktreeListReviewCacheInputs(
  state: WorktreeListReviewCacheState,
  groupBy: WorktreeGroupBy,
  cardProperties: readonly WorktreeCardProperty[]
): WorktreeListReviewCacheInputs {
  const hasFolderWorkspaces = state.folderWorkspaces.length > 0
  const newCardStyle = state.settings?.experimentalNewWorktreeCardStyle === true
  const folderCardsNeedReview =
    hasFolderWorkspaces &&
    (newCardStyle ? cardProperties.includes('status') : cardProperties.includes('pr'))
  const needsPrCache = groupBy === 'pr-status' || folderCardsNeedReview
  const needsHostedReviewCache = newCardStyle && folderCardsNeedReview

  // Why: ordinary git worktree cards own entry-level subscriptions. The list
  // needs whole caches only for PR grouping or synthetic folder-card displays.
  if (!needsPrCache && !needsHostedReviewCache) {
    return EMPTY_WORKTREE_LIST_REVIEW_CACHE_INPUTS
  }
  return {
    prCache: needsPrCache ? state.prCache : null,
    hostedReviewCache: needsHostedReviewCache ? state.hostedReviewCache : null
  }
}
