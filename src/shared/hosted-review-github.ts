import type { PRCheckDetail, PRComment, PRInfo } from './types'
import type { HostedReviewQueueSummary } from './hosted-review'

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
  if (!checks || checks.length === 0) {
    return prChecksStatus
  }
  const hasFailure = checks.some(
    (check) => check.conclusion === 'failure' || check.conclusion === 'timed_out'
  )
  if (hasFailure) {
    return 'failure'
  }
  const hasPending = checks.some(
    (check) =>
      check.status !== 'completed' || check.conclusion === null || check.conclusion === 'pending'
  )
  if (hasPending) {
    return 'pending'
  }
  const hasSuccess = checks.some((check) => check.conclusion === 'success')
  if (hasSuccess) {
    return 'success'
  }
  return 'neutral'
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
    checksStatus: deriveChecksStatus(args.pr.checksStatus, args.checks),
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
