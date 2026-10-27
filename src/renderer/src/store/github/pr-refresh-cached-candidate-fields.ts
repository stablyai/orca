import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-request-refresh-types'
import type { CacheEntry } from './cache-model'

/** What a PR refresh candidate tells main about the cached answer it may keep. */
export function cachedPRCandidateFields(
  cached: CacheEntry<PRInfo> | undefined
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
    cachedHeadOid: cached?.fetchedHeadOid ?? cached?.data?.headSha ?? null,
    cachedHasPR: cached?.data ? true : cached ? false : null,
    cachedPRState: cached?.data?.state ?? null,
    cachedChecksStatus: cached?.data?.checksStatus ?? null,
    cachedMergeable: cached?.data?.mergeable ?? null,
    cachedMergeStateStatus: cached?.data?.mergeStateStatus ?? null
  }
}
