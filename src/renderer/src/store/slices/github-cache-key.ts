import type { GlobalSettings } from '../../../../shared/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'

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
  const owner = repoId ?? repoPath
  const scope = getGitHubCacheHostScope(settings, connectionId, executionHostId, hasRepoOwner)
  // Why: runtime/SSH lookups can observe different remotes than the local repo
  // path, so cache keys include the repo's owning execution boundary.
  if (scope) {
    return `${scope}::${owner}::${suffix}`
  }
  return `${owner}::${suffix}`
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
  return `${repoId ?? repoPath}::${suffix}`
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
