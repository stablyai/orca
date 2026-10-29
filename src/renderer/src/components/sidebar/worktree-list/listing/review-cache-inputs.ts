import type { AppState } from '@/store/types'
import type { WorktreeCardProperty } from '../../../../../../shared/ui-chrome-types'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

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
  const hasFolderWorkspaces = selectFolderWorkspaces(state).length > 0
  const newCardStyle = state.settings?.experimentalNewWorktreeCardStyle === true
  const folderCardsNeedReview =
    hasFolderWorkspaces &&
    (newCardStyle ? cardProperties.includes('status') : cardProperties.includes('pr'))
  const needsPrCache = groupBy === 'pr-status' || folderCardsNeedReview
  const needsHostedReviewCache = newCardStyle && folderCardsNeedReview

  // Cards subscribe per entry; only PR grouping and synthetic folder cards need whole caches.
  if (!needsPrCache && !needsHostedReviewCache) {
    return EMPTY_WORKTREE_LIST_REVIEW_CACHE_INPUTS
  }
  return {
    prCache: needsPrCache ? state.prCache : null,
    hostedReviewCache: needsHostedReviewCache ? state.hostedReviewCache : null
  }
}
