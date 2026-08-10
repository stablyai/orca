import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { getWorktreeCardPrDisplay, type WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { Worktree } from '../../../../shared/types'

export type WorktreeCopyTargets = {
  path: string
  /** Null for detached HEAD and for workspaces that are not on a branch. */
  branchName: string | null
  reviewLabel: 'PR' | 'MR'
  /** Null until the hosted-review lookup resolves a web URL; the menu item stays disabled. */
  reviewUrl: string | null
}

type LinkedReviewFields = Pick<
  Worktree,
  'linkedPR' | 'linkedGitLabMR' | 'linkedBitbucketPR' | 'linkedAzureDevOpsPR' | 'linkedGiteaPR'
>

// Why: the card already resolves the review it renders; deriving from linked metadata is only
// the standalone fallback so the menu never contradicts the badge on the row it wraps.
function resolveReview(
  worktree: LinkedReviewFields,
  review: WorktreeCardPrDisplay | null | undefined
): WorktreeCardPrDisplay | null {
  if (review !== undefined) {
    return review
  }
  return getWorktreeCardPrDisplay(
    undefined,
    worktree.linkedPR ?? null,
    worktree.linkedGitLabMR ?? null,
    worktree.linkedBitbucketPR ?? null,
    worktree.linkedAzureDevOpsPR ?? null,
    worktree.linkedGiteaPR ?? null
  )
}

export function getWorktreeCopyTargets(args: {
  worktree: Pick<Worktree, 'path' | 'branch' | 'head'> & LinkedReviewFields
  /** Branch already stripped by the owning card; omit to derive from the worktree. */
  branchName?: string | null
  /** Explicit `null` means the owner resolved "no review"; `undefined` means it did not resolve one. */
  review?: WorktreeCardPrDisplay | null
}): WorktreeCopyTargets {
  const { worktree } = args
  const identity = getWorktreeGitIdentityDisplay(worktree)
  const derivedBranch = identity?.kind === 'branch' ? identity.branchName : null
  const providedBranch = args.branchName?.trim()
  const review = resolveReview(worktree, args.review)
  return {
    path: worktree.path,
    branchName: providedBranch || derivedBranch,
    // Why: GitLab is the only supported provider that calls them merge requests; unknown defaults to PR.
    reviewLabel: review?.provider === 'gitlab' ? 'MR' : 'PR',
    reviewUrl: review?.url ?? null
  }
}
