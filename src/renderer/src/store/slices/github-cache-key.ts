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
  executionHostId?: string | null
): string {
  const owner = repoId ?? repoPath
  const scope = getGitHubCacheHostScope(settings, connectionId, executionHostId)
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
  executionHostId?: string | null
): string | null {
  const hostId = normalizeExecutionHostId(executionHostId)
  if (hostId) {
    return hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
  }
  const runtimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim()
  if (runtimeEnvironmentId) {
    return `runtime:${encodeURIComponent(runtimeEnvironmentId)}`
  }
  const sshConnectionId = connectionId?.trim()
  return sshConnectionId ? toSshExecutionHostId(sshConnectionId) : null
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
  executionHostId?: string | null
): string {
  return getGitHubRepoCacheKey(repoPath, repoId, branch, settings, connectionId, executionHostId)
}

export function getLegacyGitHubPRCacheKey(
  repoPath: string,
  repoId: string | undefined,
  branch: string
): string {
  return getLegacyGitHubRepoCacheKey(repoPath, repoId, branch)
}
