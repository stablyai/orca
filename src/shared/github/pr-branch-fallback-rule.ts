import type { PRInfo } from './pull-request-types'
import type { GitHubPRRefreshCandidate } from './pull-request-refresh-types'

export type PRBranchFallback = {
  fallbackPRNumber: number | null
  fallbackPRSource: 'pr-cache' | 'hosted-review' | null
}

const NO_FALLBACK: PRBranchFallback = { fallbackPRNumber: null, fallbackPRSource: null }

/**
 * The PR number a branch lookup may fall back to when the branch itself finds none: the last PR result,
 * else the hosted-review hint, and never for a linked PR. A merged PR is dropped once the head moved past it.
 */
export function resolvePRBranchFallback(args: {
  linkedPRNumber: number | null
  cachedPR: Pick<PRInfo, 'number' | 'state' | 'headSha' | 'confirmedContainedHeadOid'> | null
  hintPRNumber: number | null
  currentHeadOid: string | null | undefined
}): PRBranchFallback {
  const { linkedPRNumber, cachedPR, hintPRNumber, currentHeadOid } = args
  if (linkedPRNumber != null) {
    return NO_FALLBACK
  }
  if (cachedPR) {
    // An unknown head (a phone before its git status) can't prove the branch moved on.
    const mergedPRMovedPastHead =
      currentHeadOid != null &&
      cachedPR.state === 'merged' &&
      cachedPR.headSha !== currentHeadOid &&
      cachedPR.confirmedContainedHeadOid !== currentHeadOid
    return mergedPRMovedPastHead
      ? NO_FALLBACK
      : { fallbackPRNumber: cachedPR.number, fallbackPRSource: 'pr-cache' }
  }
  return hintPRNumber != null
    ? { fallbackPRNumber: hintPRNumber, fallbackPRSource: 'hosted-review' }
    : NO_FALLBACK
}

/** Whether `resolvePRBranchFallback` reads the hint: only with no link and no PR result of its own. */
export function prBranchFallbackNeedsHint(args: {
  linkedPRNumber: number | null
  cachedPR: unknown
}): boolean {
  return args.linkedPRNumber == null && args.cachedPR == null
}

/** A fallback the caller already trusts may stay visible after it merged. */
export function shouldAcceptMergedFallbackPR(
  candidate: Pick<
    GitHubPRRefreshCandidate,
    'linkedPRNumber' | 'fallbackPRNumber' | 'fallbackPRSource'
  >
): boolean {
  return (
    candidate.linkedPRNumber == null &&
    candidate.fallbackPRNumber != null &&
    candidate.fallbackPRSource != null
  )
}
