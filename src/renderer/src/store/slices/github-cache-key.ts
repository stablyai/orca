import type { AppState } from '../types'

export function getGitHubRepoCacheKey(
  repoPath: string,
  repoId: string | undefined,
  suffix: string,
  settings?: AppState['settings'],
  connectionId?: string | null
): string {
  const runtimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim()
  const owner = repoId ?? repoPath
  // Why: runtime/SSH lookups can observe different remotes than the local repo
  // path, so cache keys include the active remote execution boundary.
  if (runtimeEnvironmentId) {
    return `runtime:${runtimeEnvironmentId}::${owner}::${suffix}`
  }
  const sshConnectionId = connectionId?.trim()
  return sshConnectionId ? `ssh:${sshConnectionId}::${owner}::${suffix}` : `${owner}::${suffix}`
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
  settings?: AppState['settings'],
  connectionId?: string | null
): string {
  return getGitHubRepoCacheKey(repoPath, repoId, branch, settings, connectionId)
}

export function getLegacyGitHubPRCacheKey(
  repoPath: string,
  repoId: string | undefined,
  branch: string
): string {
  return getLegacyGitHubRepoCacheKey(repoPath, repoId, branch)
}
