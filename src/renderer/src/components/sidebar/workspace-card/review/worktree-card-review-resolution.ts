import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Translate } from '@/i18n/use-translate'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import {
  deriveWorktreeCardPrDisplay,
  getWorktreeReviewCacheKeys
} from './worktree-card-pr-derivation'

export const getWorktreeCardReviewCacheKeys = getWorktreeReviewCacheKeys

export function resolveWorktreeCardReview(
  worktree: Worktree,
  hostedReviewEntry: AppState['hostedReviewCache'][string] | undefined,
  prCacheEntry: AppState['prCache'][string] | undefined,
  t?: Translate
) {
  return {
    linkedGitHubPR: worktree.linkedPR ?? null,
    linkedGitLabMR: worktree.linkedGitLabMR ?? null,
    linkedBitbucketPR: worktree.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: worktree.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: worktree.linkedGiteaPR ?? null,
    ...deriveWorktreeCardPrDisplay(worktree, hostedReviewEntry, prCacheEntry, t)
  }
}

/** The PR state a workspace card shows, or null when it shows none. */
export function selectWorktreeCardReviewState(
  state: Pick<AppState, 'hostedReviewCache' | 'prCache' | 'settings'>,
  worktree: Worktree,
  repo: Repo | undefined
): WorktreeCardPrDisplay['state'] | null {
  const { hostedReviewCacheKey, prCacheKey } = getWorktreeCardReviewCacheKeys(
    worktree,
    repo,
    state.settings
  )
  return (
    resolveWorktreeCardReview(
      worktree,
      hostedReviewCacheKey ? state.hostedReviewCache[hostedReviewCacheKey] : undefined,
      prCacheKey ? state.prCache?.[prCacheKey] : undefined
    ).prDisplay?.state ?? null
  )
}
