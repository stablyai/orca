import type { PreloadApi } from '../../../../preload/api-types'
import { WORKTREE_MERGE_REVIEW_UNSUPPORTED_MESSAGE } from '../../../../shared/git-merge-review'

type GitApi = NonNullable<Partial<PreloadApi>['git']>

/**
 * Why: merge review is desktop-only for now — the snapshot step needs a local
 * temp index, which the runtime wire has no primitive for. Report idle state so
 * no menu item appears, and answer the actions with an explicit refusal rather
 * than a silent no-op.
 */
export const unsupportedMergeReviewApi: Pick<
  GitApi,
  | 'worktreeMergeReviewState'
  | 'worktreeMergeReviewSync'
  | 'worktreeMergeReviewAccept'
  | 'worktreeMergeReviewReject'
> = {
  worktreeMergeReviewState: async () => ({
    phase: 'idle',
    syncSupported: false
  }),
  worktreeMergeReviewSync: async () => {
    throw new Error(WORKTREE_MERGE_REVIEW_UNSUPPORTED_MESSAGE)
  },
  worktreeMergeReviewAccept: async () => {
    throw new Error(WORKTREE_MERGE_REVIEW_UNSUPPORTED_MESSAGE)
  },
  worktreeMergeReviewReject: async () => {
    throw new Error(WORKTREE_MERGE_REVIEW_UNSUPPORTED_MESSAGE)
  }
}
