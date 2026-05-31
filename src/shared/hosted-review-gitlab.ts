import type { HostedReviewInfo, HostedReviewQueueSummary } from './hosted-review'
import type { PRCheckDetail, PRComment } from './types'

export type HostedReviewFromGitLabInfoArgs = {
  review: HostedReviewInfo & { provider: 'gitlab' }
  authorLogin?: string | null
  authorIsBot?: boolean
  comments?: PRComment[]
  checks?: PRCheckDetail[]
  lastViewedAt?: number
}

type GitLabIdentityParts = {
  host: string
  owner: string
  repo: string
}

function parseGitLabIdentity(url: string): GitLabIdentityParts {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const markerIndex = segments.indexOf('-')
    const projectSegments = markerIndex >= 0 ? segments.slice(0, markerIndex) : segments
    if (projectSegments.length >= 2) {
      return {
        host: parsed.host || 'gitlab.com',
        owner: projectSegments.slice(0, -1).join('/'),
        repo: projectSegments.at(-1) ?? 'unknown'
      }
    }
    return {
      host: parsed.host || 'gitlab.com',
      owner: projectSegments[0] ?? 'unknown',
      repo: projectSegments[1] ?? 'unknown'
    }
  } catch {
    // Why: queue badges should degrade gracefully for hand-entered/self-hosted URLs.
    return { host: 'gitlab.com', owner: 'unknown', repo: 'unknown' }
  }
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
  reviewStatus: HostedReviewInfo['status'],
  checks?: PRCheckDetail[]
): HostedReviewInfo['status'] {
  if (!checks || checks.length === 0) {
    return reviewStatus
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

export function hostedReviewSummaryFromGitLabInfo(
  args: HostedReviewFromGitLabInfoArgs
): HostedReviewQueueSummary {
  const identity = parseGitLabIdentity(args.review.url)
  const unresolvedCount = unresolvedThreadCount(args.comments)
  return {
    identity: {
      provider: 'gitlab',
      host: identity.host,
      owner: identity.owner,
      repo: identity.repo,
      number: args.review.number
    },
    title: args.review.title,
    url: args.review.url,
    state: args.review.state,
    author: args.authorLogin ? { login: args.authorLogin, isBot: args.authorIsBot } : null,
    updatedAt: args.review.updatedAt,
    mergeable: args.review.mergeable,
    ...(args.review.mergeStateStatus !== undefined
      ? { mergeStateStatus: args.review.mergeStateStatus }
      : {}),
    checksStatus: deriveChecksStatus(args.review.status, args.checks),
    reviewDecision:
      args.review.reviewDecision === 'APPROVED'
        ? 'approved'
        : args.review.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : args.review.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review_required'
            : undefined,
    threadSummary:
      unresolvedCount === null
        ? undefined
        : {
            unresolvedCount,
            dataCompleteness: 'partial'
          },
    lastViewedAt: args.lastViewedAt,
    draft: args.review.state === 'draft'
  }
}
