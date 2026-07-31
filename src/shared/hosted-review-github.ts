import type { PRCheckDetail, PRComment, PRInfo } from './types'
import type { HostedReviewInfo, HostedReviewQueueSummary } from './hosted-review'
import { derivePRCheckStatus } from './pr-check-status'

export type HostedReviewFromGitHubPRInfoArgs = {
  pr: PRInfo
  owner: string
  repo: string
  host?: string
  authorLogin?: string | null
  authorIsBot?: boolean
  requestedReviewerLogins?: string[] | null
  comments?: PRComment[]
  checks?: PRCheckDetail[]
  lastViewedAt?: number
}

function unresolvedThreadCount(comments?: PRComment[]): number | null {
  if (comments === undefined) {
    return null
  }
  const unresolved = new Set<string>()
  for (const comment of comments) {
    if (!comment.threadId || comment.isResolved !== false) {
      continue
    }
    unresolved.add(comment.threadId)
  }
  return unresolved.size
}

function deriveChecksStatus(
  prChecksStatus: PRInfo['checksStatus'],
  checks?: PRCheckDetail[]
): PRInfo['checksStatus'] {
  if (!checks) {
    return prChecksStatus
  }
  return derivePRCheckStatus(checks)
}

export function hostedReviewSummaryFromGitHubPRInfo(
  args: HostedReviewFromGitHubPRInfoArgs
): HostedReviewQueueSummary {
  const unresolvedCount = unresolvedThreadCount(args.comments)
  return {
    identity: {
      provider: 'github',
      host: args.host ?? 'github.com',
      owner: args.owner,
      repo: args.repo,
      number: args.pr.number
    },
    title: args.pr.title,
    url: args.pr.url,
    state: args.pr.state,
    author: args.authorLogin ? { login: args.authorLogin, isBot: args.authorIsBot } : null,
    updatedAt: args.pr.updatedAt,
    mergeable: args.pr.mergeable,
    ...(args.pr.mergeStateStatus !== undefined
      ? { mergeStateStatus: args.pr.mergeStateStatus }
      : {}),
    checksStatus: deriveChecksStatus(args.pr.checksStatus, args.checks),
    reviewDecision:
      args.pr.reviewDecision === 'APPROVED'
        ? 'approved'
        : args.pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : args.pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review_required'
            : undefined,
    threadSummary:
      unresolvedCount === null
        ? undefined
        : {
            unresolvedCount,
            dataCompleteness: 'partial'
          },
    requestedReviewerLogins: args.requestedReviewerLogins,
    lastViewedAt: args.lastViewedAt,
    draft: args.pr.state === 'draft'
  }
}

export function hostedReviewInfoFromGitHubPRInfo(pr: PRInfo): HostedReviewInfo {
  return {
    provider: 'github',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.checksStatus,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.reviewDecision !== undefined ? { reviewDecision: pr.reviewDecision } : {}),
    ...(pr.autoMergeEnabled !== undefined ? { autoMergeEnabled: pr.autoMergeEnabled } : {}),
    ...(pr.autoMergeAllowed !== undefined ? { autoMergeAllowed: pr.autoMergeAllowed } : {}),
    ...(pr.mergeQueueRequired !== undefined ? { mergeQueueRequired: pr.mergeQueueRequired } : {}),
    ...(pr.mergeStateStatus !== undefined ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(pr.headSha ? { headSha: pr.headSha } : {}),
    ...(pr.confirmedContainedHeadOid
      ? { confirmedContainedHeadOid: pr.confirmedContainedHeadOid }
      : {}),
    ...(pr.conflictSummary ? { conflictSummary: pr.conflictSummary } : {})
  }
}
