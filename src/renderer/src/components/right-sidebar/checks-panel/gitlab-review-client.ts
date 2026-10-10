import type { PRComment } from '../../../../../shared/github/comment-types'
import type {
  GitLabDiscussionResolveResult,
  GitLabWorkItemDetails
} from '../../../../../shared/gitlab-types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
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
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
  iid: number
  repoOwnerExecutionHostId?: string
}): Promise<GitLabWorkItemDetails | null> {
  const target = getActiveRuntimeTarget(args.settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<GitLabWorkItemDetails | null>(
      target,
      'gitlab.workItemDetails',
      {
        repo: args.repoId ?? args.repoPath,
        iid: args.iid,
        type: 'mr'
      },
      { timeoutMs: 30_000 }
    )
  }
  return (await window.api.gl.workItemDetails({
    repoPath: args.repoPath,
    repoId: args.repoId,
    repoOwnerExecutionHostId: args.repoOwnerExecutionHostId,
    iid: args.iid,
    type: 'mr'
  })) as GitLabWorkItemDetails | null
}

export async function resolveGitLabMRDiscussionForChecks(args: {
  repoPath: string
  repoId?: string
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
  iid: number
  discussionId: string
  resolved: boolean
}): Promise<GitLabDiscussionResolveResult> {
  const target = getActiveRuntimeTarget(args.settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<GitLabDiscussionResolveResult>(
      target,
      'gitlab.resolveMRDiscussion',
      {
        repo: args.repoId ?? args.repoPath,
        iid: args.iid,
        discussionId: args.discussionId,
        resolved: args.resolved
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gl.resolveMRDiscussion({
    repoPath: args.repoPath,
    repoId: args.repoId,
    iid: args.iid,
    discussionId: args.discussionId,
    resolved: args.resolved
  })
}
