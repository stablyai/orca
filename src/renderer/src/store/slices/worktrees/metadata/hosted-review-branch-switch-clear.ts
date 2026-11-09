import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { HostedReviewLinkKey } from '../listing/worktree-slice-types'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  HOSTED_REVIEW_LINK_KEYS
} from '../../../../../../shared/worktree/hosted-review-links'
import { getLinkedGitHubPRRepository } from '../../../github/pull-requests/linked-pr-repository'

/** What one branch-switch clear wrote; replayed by re-clears, persistence and tombstones. */
export type HostedReviewLinkClear = Partial<Pick<WorktreeMeta, HostedReviewLinkKey | 'pushTarget'>>

const CLEARED_PUSH_TARGET_UPDATES: HostedReviewLinkClear = { pushTarget: undefined }

/** What a branch switch clears; a PR linked from another repository names no branch of this worktree. */
export function getBranchSwitchHostedReviewClear(
  worktree: Worktree,
  repo: Repo | undefined
): HostedReviewLinkClear | null {
  const hasPushTarget = worktree.pushTarget !== undefined
  if (getLinkedGitHubPRRepository(worktree, repo)) {
    return hasPushTarget ? CLEARED_PUSH_TARGET_UPDATES : null
  }
  return HOSTED_REVIEW_LINK_KEYS.some((key) => worktree[key] != null) || hasPushTarget
    ? CLEARED_HOSTED_REVIEW_LINK_UPDATES
    : null
}

export function hasBranchScopedHostedReviewContext(worktree: Worktree, repo?: Repo): boolean {
  return getBranchSwitchHostedReviewClear(worktree, repo) !== null
}

export function hostedReviewLinksAreCleared(
  worktree: Partial<Pick<Worktree, HostedReviewLinkKey | 'pushTarget'>>,
  cleared: HostedReviewLinkClear = CLEARED_HOSTED_REVIEW_LINK_UPDATES
): boolean {
  return (
    HOSTED_REVIEW_LINK_KEYS.every((key) => !(key in cleared) || worktree[key] == null) &&
    !worktree.pushTarget
  )
}
