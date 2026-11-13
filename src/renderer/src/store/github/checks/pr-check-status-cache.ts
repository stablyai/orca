import { capturePRCheckContract } from '@/lib/source-control/checks/pr-check-observation-contract'
import { isCompletePRCheckOwner } from '../../../../../shared/github/checks/complete-pr-check-owner'
import type { AppState } from '../../types'
import type { GitHubPRRefreshAlias } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import { derivePRCheckStatus as deriveCheckStatusFromChecks } from '../../../../../shared/source-control/checks/pr-check-status'
import { getPRChecksCacheTtl, prChecksCacheSuffix } from '../cache/cache-identity'
import { getGitHubRepoCacheKey } from '../../../../../shared/github/cache/github-cache-key'

export function applyCachedChecksStatus(
  state: AppState,
  alias: GitHubPRRefreshAlias,
  pr: PRInfo,
  fetchedAt: number,
  aliasExecutionHostId: string
): PRInfo {
  if (
    isCompletePRCheckOwner(pr) ||
    capturePRCheckContract(
      () => state,
      aliasExecutionHostId.startsWith('runtime:')
        ? { kind: 'environment', environmentId: aliasExecutionHostId.slice(8) }
        : { kind: 'local' }
    ).complete
  ) {
    return pr
  }
  const checksCacheKeys = [
    ...(alias.repoId
      ? [
          ...(pr.headSha
            ? [
                getGitHubRepoCacheKey(
                  alias.repoPath,
                  alias.repoId,
                  prChecksCacheSuffix(pr.number, pr.prRepo, pr.headSha),
                  state.settings,
                  alias.connectionId,
                  aliasExecutionHostId,
                  true
                )
              ]
            : []),
          getGitHubRepoCacheKey(
            alias.repoPath,
            alias.repoId,
            prChecksCacheSuffix(pr.number, pr.prRepo),
            state.settings,
            alias.connectionId,
            aliasExecutionHostId,
            true
          )
        ]
      : []),
    ...(pr.headSha
      ? [
          getGitHubRepoCacheKey(
            alias.repoPath,
            undefined,
            prChecksCacheSuffix(pr.number, pr.prRepo, pr.headSha),
            state.settings,
            alias.connectionId,
            aliasExecutionHostId,
            true
          )
        ]
      : []),
    getGitHubRepoCacheKey(
      alias.repoPath,
      undefined,
      prChecksCacheSuffix(pr.number, pr.prRepo),
      state.settings,
      alias.connectionId,
      aliasExecutionHostId,
      true
    ),
    `${alias.repoPath}::pr-checks::${pr.number}`
  ]
  const checksEntry = checksCacheKeys
    .map((key) => state.checksCache[key])
    .find((entry) => entry?.data)
  if (
    checksEntry?.data &&
    checksEntry.headSha &&
    pr.headSha &&
    checksEntry.headSha === pr.headSha &&
    fetchedAt - checksEntry.fetchedAt < getPRChecksCacheTtl(checksEntry)
  ) {
    const checksStatus = deriveCheckStatusFromChecks(checksEntry.data)
    return checksStatus === pr.checksStatus ? pr : { ...pr, checksStatus, checksSummary: undefined }
  }
  return pr
}
