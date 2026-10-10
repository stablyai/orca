import type { PRComment } from '../../../../../shared/github/comment-types'
import type {
  GitLabDiscussionResolveResult,
  GitLabWorkItemDetails
} from '../../../../../shared/gitlab-types'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import type { ChecksPanelReview } from '../checks-panel-review'

export function isGitLabChecksPanelReview(
  review: ChecksPanelReview | null
): review is ChecksPanelReview & { provider: 'gitlab' } {
  return review?.provider === 'gitlab'
}

export function gitLabMRCommentsToPRComments(
  comments: GitLabWorkItemDetails['comments'] | undefined
): PRComment[] {
  return (comments ?? []).map((comment) => {
    const { reactions: _reactions, ...compatibleComment } = comment
    // Why: the shared comments renderer expects GitHub reaction enums; GitLab award names are open-ended, so omit them here.
    return compatibleComment
  })
}

export async function fetchGitLabMRDetailsForChecks(args: {
  repoPath: string
  repoId?: string
  iid: number
  repoOwnerExecutionHostId?: string
}): Promise<GitLabWorkItemDetails | null> {
  return gitLabApiFor(args).workItemDetails({
    repoPath: args.repoPath,
    repoId: args.repoId,
    repoOwnerExecutionHostId: args.repoOwnerExecutionHostId,
    iid: args.iid,
    type: 'mr'
  })
}

export async function resolveGitLabMRDiscussionForChecks(args: {
  repoPath: string
  repoId?: string
  iid: number
  discussionId: string
  resolved: boolean
  repoOwnerExecutionHostId?: string
}): Promise<GitLabDiscussionResolveResult> {
  return gitLabApiFor(args).resolveMRDiscussion({
    repoPath: args.repoPath,
    repoId: args.repoId,
    iid: args.iid,
    discussionId: args.discussionId,
    resolved: args.resolved
  })
}
