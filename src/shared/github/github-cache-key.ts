import type { GlobalSettings } from '../global-settings-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import { taskSourceCacheScopeHostId } from '../task-source-context'

type RuntimeFocusSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export function getGitHubRepoCacheKey(
  repoPath: string,
  repoId: string | undefined,
  suffix: string,
  settings?: RuntimeFocusSettings,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string {
  // Why: runtime/SSH lookups can observe different remotes than the local repo
  // path, so cache keys include the repo's owning execution boundary.
  return composeRepoCacheKey(
    getGitHubCacheHostScope(settings, connectionId, executionHostId, hasRepoOwner),
    repoId ?? repoPath,
    suffix
  )
}

/**
 * The one shape of a repo-owned cache key: `[scope::]owner::suffix`, where scope is an execution
 * host id or a task-source scope and no scope means this computer. Read back by repoCacheKeyHostId.
 */
export function composeRepoCacheKey(
  scope: string | null | undefined,
  owner: string,
  suffix: string
): string {
  return scope ? `${scope}::${owner}::${suffix}` : `${owner}::${suffix}`
}

/** Which host's bucket `key` is when one of `owners` (repo id or path) owns it; null when none does. */
export function repoCacheKeyHostId(key: string, owners: readonly string[]): ExecutionHostId | null {
  if (owners.some((owner) => key.startsWith(`${owner}::`))) {
    return LOCAL_EXECUTION_HOST_ID
  }
  // Why not the first `::`: a task-source scope with empty parts contains `::` itself.
  for (const owner of owners) {
    const marker = `::${owner}::`
    for (let at = key.indexOf(marker); at !== -1; at = key.indexOf(marker, at + 1)) {
      const scope = key.slice(0, at)
      // Why the `::` check: a composed host id is encoded, so a candidate spanning `::` is owner + suffix.
      const hostId =
        (scope.includes('::') ? null : normalizeExecutionHostId(scope)) ??
        taskSourceCacheScopeHostId(scope)
      if (hostId) {
        return hostId
      }
    }
  }
  return null
}

function getGitHubCacheHostScope(
  settings?: RuntimeFocusSettings,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string | null {
  const hostId = normalizeExecutionHostId(executionHostId)
  if (hostId) {
    return hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
  }
  const sshConnectionId = connectionId?.trim()
  if (sshConnectionId) {
    return toSshExecutionHostId(sshConnectionId)
  }
  // Why: an existing repo with no remote/runtime owner is local; only missing
  // owner context should inherit the focused runtime fallback.
  if (hasRepoOwner) {
    return null
  }
  const runtimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim()
  if (runtimeEnvironmentId) {
    return `runtime:${encodeURIComponent(runtimeEnvironmentId)}`
  }
  return null
}

export function getLegacyGitHubRepoCacheKey(
  repoPath: string,
  repoId: string | undefined,
  suffix: string
): string {
  return composeRepoCacheKey(null, repoId ?? repoPath, suffix)
}

export function getGitHubPRCacheKey(
  repoPath: string,
  repoId: string | undefined,
  branch: string,
  settings?: RuntimeFocusSettings,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string {
  return getGitHubRepoCacheKey(
    repoPath,
    repoId,
    branch,
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
}

export function getLegacyGitHubPRCacheKey(
  repoPath: string,
  repoId: string | undefined,
  branch: string
): string {
  return getLegacyGitHubRepoCacheKey(repoPath, repoId, branch)
}

/** Every key a repo's branch PR may sit under in the cache, the repo-scoped one first. */
export function getGitHubPRCacheKeyCandidates(
  repo: { path: string; id: string; connectionId?: string | null; executionHostId?: string | null },
  branch: string
): string[] {
  return [
    getGitHubPRCacheKey(
      repo.path,
      repo.id,
      branch,
      null,
      repo.connectionId,
      repo.executionHostId,
      true
    ),
    getLegacyGitHubPRCacheKey(repo.path, repo.id, branch),
    getLegacyGitHubPRCacheKey(repo.path, undefined, branch)
  ]
}
