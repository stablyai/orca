import type { GitHubSlice } from '../github-slice-contract'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { GitHubPRRefreshCandidate } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { CacheEntry } from '../cache/cache-model'

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

/** The PR read's transport options; a refresh timer's read or retry goes out as background. */
export function prReadRpcOptions(options: Parameters<GitHubSlice['fetchPRForBranch']>[2]) {
  return { timeoutMs: 30_000, signal: options?.signal, background: options?.background === true }
}

/** A branch-scoped refetch of the same refresh, keeping its reason, user act and background tag. */
export function refetchPRByBranch(
  state: Pick<GitHubSlice, 'fetchPRForBranch'>,
  repoPath: string,
  branch: string,
  options: NonNullable<Parameters<GitHubSlice['fetchPRForBranch']>[2]>,
  owner: { repoId: string | undefined; executionHostId: string | undefined }
): void {
  void state
    .fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId: owner.repoId,
      repoOwnerExecutionHostId: owner.executionHostId,
      worktreeId: options.worktreeId,
      reason: options.reason,
      ...(options.userRefresh === true ? { userRefresh: true } : {}),
      ...(options.background === true ? { background: true } : {})
    })
    .catch((err) => console.warn('Branch-scoped PR refetch skipped:', err))
}
