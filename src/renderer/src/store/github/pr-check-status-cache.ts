import type { AppState } from '../types'
import type { GitHubPRRefreshAlias } from '../../../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { deriveCheckStatusFromChecks } from '../slices/github-checks'
import {
  getPRChecksCacheTtl,
  prChecksCacheSuffix,
  runtimeScopedRepoCacheKey
} from './cache-identity'

export function applyCachedChecksStatus(
  state: AppState,
  alias: GitHubPRRefreshAlias,
  pr: PRInfo,
  fetchedAt: number,
  aliasExecutionHostId: string
): PRInfo {
  const checksCacheKeys = [
    ...(alias.repoId
      ? [
          ...(pr.headSha
            ? [
                runtimeScopedRepoCacheKey(
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
          runtimeScopedRepoCacheKey(
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
          runtimeScopedRepoCacheKey(
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
    runtimeScopedRepoCacheKey(
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
    return { ...pr, checksStatus: deriveCheckStatusFromChecks(checksEntry.data) }
  }
  return pr
}
