import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type {
  GiteaDiscussionResolveResult,
  GiteaPipelineJob,
  GiteaWorkItemDetails
} from '../../../../../shared/gitea-types'
import { giteaApiFor } from '@/runtime/gitea-owner-api'
import type { ChecksPanelReview } from '../checks-panel-review'

export function isGiteaChecksPanelReview(
  review: ChecksPanelReview | null
): review is ChecksPanelReview & { provider: 'gitea' } {
  return review?.provider === 'gitea'
}

export function giteaPRCommentsToPRComments(
  comments: GiteaWorkItemDetails['comments'] | undefined
): PRComment[] {
  return (comments ?? []).map((comment) => {
    const { reactions: _reactions, ...compatibleComment } = comment
    // Omit open-ended Gitea reaction names; the shared renderer expects GitHub reaction enums.
    return compatibleComment
  })
}

function giteaJobStatusToCheckStatus(status: string): PRCheckDetail['status'] {
  const s = status.toLowerCase()
  if (s === 'running' || s === 'in_progress') {
    return 'in_progress'
  }
  if (s === 'waiting' || s === 'queued' || s === 'pending' || s === 'blocked' || s === 'created') {
    return 'queued'
  }
  return 'completed'
}

function giteaJobStatusToConclusion(status: string): PRCheckDetail['conclusion'] {
  const s = status.toLowerCase()
  if (s === 'success') {
    return 'success'
  }
  if (s === 'failure' || s === 'failed' || s === 'error') {
    return 'failure'
  }
  if (s === 'cancelled' || s === 'canceled') {
    return 'cancelled'
  }
  if (s === 'skipped') {
    return 'skipped'
  }
  if (
    s === 'running' ||
    s === 'in_progress' ||
    s === 'waiting' ||
    s === 'queued' ||
    s === 'pending' ||
    s === 'blocked' ||
    s === 'created'
  ) {
    return 'pending'
  }
  return null
}

export function giteaPipelineJobsToPRChecks(jobs: GiteaPipelineJob[]): PRCheckDetail[] {
  return jobs.map((job) => ({
    name: job.stage ? `${job.stage}: ${job.name}` : job.name,
    status: giteaJobStatusToCheckStatus(job.status),
    conclusion: giteaJobStatusToConclusion(job.status),
    url: job.webUrl || null,
    // External commit statuses carry id 0 and have no Actions log to load.
    ...(job.id ? { giteaJobId: job.id } : {})
  }))
}

export async function fetchGiteaReviewDataForChecks(args: {
  repoPath: string
  repoId?: string
  number: number
  repoOwnerExecutionHostId?: string
  background?: boolean
}): Promise<GiteaWorkItemDetails | null> {
  return giteaApiFor(args).workItemDetails({
    repoPath: args.repoPath,
    repoId: args.repoId,
    repoOwnerExecutionHostId: args.repoOwnerExecutionHostId,
    number: args.number,
    type: 'pr',
    includeReviewDetails: false,
    ...(args.background ? { background: true } : {})
  })
}

export async function resolveGiteaPRDiscussionForChecks(args: {
  repoPath: string
  repoId?: string
  number: number
  discussionId: string
  resolved: boolean
  repoOwnerExecutionHostId?: string
}): Promise<GiteaDiscussionResolveResult> {
  return giteaApiFor(args).resolvePRDiscussion({
    repoPath: args.repoPath,
    repoId: args.repoId,
    number: args.number,
    discussionId: args.discussionId,
    resolved: args.resolved
  })
}
