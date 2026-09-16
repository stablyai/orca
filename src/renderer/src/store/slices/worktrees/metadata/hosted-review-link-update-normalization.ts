import { normalizeGitHubPRSuppressionUpdate } from '../../../../../../shared/worktree/github-pr-suppression'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { clearOlderHostedReviewLinksForReplacement } from './hosted-review-link-mutation'

export function normalizeHostedReviewLinkReplacementUpdates(
  updates: Partial<WorktreeMeta>,
  existingWorktree?: Worktree
): Partial<WorktreeMeta> {
  const replacementUpdates = existingWorktree
    ? clearOlderHostedReviewLinksForReplacement(updates, existingWorktree)
    : updates
  return normalizeGitHubPRSuppressionUpdate(replacementUpdates)
}
