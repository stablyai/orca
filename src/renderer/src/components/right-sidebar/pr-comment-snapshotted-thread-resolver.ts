import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type {
  PendingPRCommentAiAckGithubResolveTarget,
  PendingPRCommentAiAckGitlabTarget
} from './pr-comments-ai-launch-ack'

/** Host outcome shape; GitLab reports a message, GitHub only reports success. */
export type SnapshottedThreadResolveOutcome = { ok: boolean; error?: string }

export type SnapshottedThreadResolverDeps = {
  provider: HostedReviewInfo['provider']
  githubResolveTarget?: PendingPRCommentAiAckGithubResolveTarget
  gitlabTarget?: PendingPRCommentAiAckGitlabTarget
  resolveReviewThread: (
    repoPath: string,
    prNumber: number,
    threadId: string,
    resolve: boolean,
    options: {
      repoId: string
      prRepo?: PendingPRCommentAiAckGithubResolveTarget['prRepo']
    }
  ) => Promise<boolean>
  resolveGitLabDiscussion: (args: {
    repoPath: string
    repoId: string
    iid: number
    discussionId: string
    resolved: boolean
  }) => Promise<SnapshottedThreadResolveOutcome>
  /** False once the panel moved to another review: host calls continue, UI writes stop. */
  isPanelStillOnLaunchReview: () => boolean
  onResolvedOptimistically: (threadId: string) => void
  onResolveFailed: (args: { threadId: string; error?: string }) => void
}

/**
 * Resolve one host thread against the review snapshotted at launch: the panel can be showing a
 * different PR/MR by the time the agent prompt lands, so live state must not pick the target.
 */
export function buildSnapshottedThreadResolver(
  deps: SnapshottedThreadResolverDeps
): (threadId: string) => Promise<boolean> {
  return async (threadId: string): Promise<boolean> => {
    const outcome = await resolveOnHost(deps, threadId)
    if (!outcome.ok) {
      deps.onResolveFailed({ threadId, error: outcome.error })
      return false
    }
    // Why: the optimistic row must never land in another review's list; the caller's guarded
    // refresh reconciles whichever panel is actually showing.
    if (deps.isPanelStillOnLaunchReview()) {
      deps.onResolvedOptimistically(threadId)
    }
    return true
  }
}

async function resolveOnHost(
  deps: SnapshottedThreadResolverDeps,
  threadId: string
): Promise<SnapshottedThreadResolveOutcome> {
  try {
    if (deps.provider === 'gitlab') {
      if (!deps.gitlabTarget) {
        return { ok: false }
      }
      return await deps.resolveGitLabDiscussion({
        repoPath: deps.gitlabTarget.repoPath,
        repoId: deps.gitlabTarget.repoId,
        iid: deps.gitlabTarget.iid,
        discussionId: threadId,
        resolved: true
      })
    }
    if (deps.provider !== 'github' || !deps.githubResolveTarget) {
      return { ok: false }
    }
    const target = deps.githubResolveTarget
    const ok = await deps.resolveReviewThread(target.repoPath, target.prNumber, threadId, true, {
      repoId: target.repoId,
      prRepo: target.prRepo
    })
    return { ok }
  } catch (err) {
    // Why: one rejected host call would otherwise abort the whole bulk ack pool.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
