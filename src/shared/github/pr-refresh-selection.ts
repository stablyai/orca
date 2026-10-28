import type { GitHubPRRefreshCandidate } from './pull-request-refresh-types'
import { mergedPRMatchesHead, type PRCacheEntry } from './pr-cache-result'

/** What a PR refresh candidate tells main about the cached answer it may keep. */
export function cachedPRCandidateFields(
  cached: PRCacheEntry | undefined,
  currentHeadOid?: string | null
): Pick<
  GitHubPRRefreshCandidate,
  | 'cachedFetchedAt'
  | 'cachedHeadOid'
  | 'cachedHasPR'
  | 'cachedPRState'
  | 'cachedChecksStatus'
  | 'cachedMergeable'
  | 'cachedMergeStateStatus'
> {
  return {
    cachedFetchedAt: cached?.fetchedAt ?? null,
    cachedHeadOid: mergedPRMatchesHead(cached?.data, currentHeadOid)
      ? currentHeadOid
      : (cached?.fetchedHeadOid ?? cached?.data?.headSha ?? null),
    cachedHasPR: cached?.data ? true : cached ? false : null,
    cachedPRState: cached?.data?.state ?? null,
    cachedChecksStatus: cached?.data?.checksStatus ?? null,
    cachedMergeable: cached?.data?.mergeable ?? null,
    cachedMergeStateStatus: cached?.data?.mergeStateStatus ?? null
  }
}

export function selectPRRefreshFallback(input: {
  linkedPRNumber?: number | null
  cachedPR?: PRCacheEntry['data']
  currentHeadOid?: string | null
  hostedReviewFallbackPRNumber?: number | null
}): Pick<GitHubPRRefreshCandidate, 'fallbackPRNumber' | 'fallbackPRSource'> {
  const { linkedPRNumber, cachedPR, currentHeadOid, hostedReviewFallbackPRNumber } = input
  const mergedPRMovedPastHead =
    cachedPR?.state === 'merged' &&
    cachedPR.headSha !== currentHeadOid &&
    cachedPR.confirmedContainedHeadOid !== currentHeadOid
  if (linkedPRNumber != null || mergedPRMovedPastHead) {
    return { fallbackPRNumber: null, fallbackPRSource: null }
  }
  const fallbackPRNumber = cachedPR?.number ?? hostedReviewFallbackPRNumber ?? null
  return {
    fallbackPRNumber,
    fallbackPRSource: fallbackPRNumber == null ? null : cachedPR ? 'pr-cache' : 'hosted-review'
  }
}
