import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { composeRepoCacheKey } from '../../../../shared/github/github-cache-key'
import {
  getSettingsFocusedExecutionHostId,
  normalizeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'

export type LinkedReviewHints = {
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}

export function getHostedReviewCacheKey(
  repoPath: string,
  branch: string,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  repoId?: string | null,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string {
  const scope = getHostedReviewCacheHostScope(settings, connectionId, executionHostId, hasRepoOwner)
  return composeRepoCacheKey(scope, repoId ?? repoPath, branch)
}

function getHostedReviewCacheHostScope(
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string {
  const hostId = normalizeExecutionHostId(executionHostId)
  if (hostId) {
    return hostId
  }
  const sshConnectionId = connectionId?.trim()
  if (sshConnectionId) {
    return toSshExecutionHostId(sshConnectionId)
  }
  // Known owner without remote markers is local; absent owner context retains active-host focus fallback.
  if (hasRepoOwner) {
    return 'local'
  }
  return getSettingsFocusedExecutionHostId(settings)
}

// Branch results can differ from exact linked review; track provenance without changing cache key.
export function linkedReviewHintKey(options?: LinkedReviewHints): string {
  const hints = [
    ['github', options?.linkedGitHubPR ?? options?.fallbackGitHubPR ?? null],
    ['gitlab', options?.linkedGitLabMR ?? null],
    ['bitbucket', options?.linkedBitbucketPR ?? null],
    ['azure-devops', options?.linkedAzureDevOpsPR ?? null],
    ['gitea', options?.linkedGiteaPR ?? null]
  ] as const
  return hints
    .filter(([, number]) => number !== null)
    .map(([provider, number]) => `${provider}:${number}`)
    .join('|')
}
