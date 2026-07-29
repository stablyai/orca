import type { GlobalSettings } from '../../../../shared/types'
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
  return `${scope}::${repoId ?? repoPath}::${branch}`
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
  // Why: a known repo owner with no SSH/runtime marker is local; absent owner
  // context keeps the focused-runtime fallback for active-host operations.
  if (hasRepoOwner) {
    return 'local'
  }
  return getSettingsFocusedExecutionHostId(settings)
}

// Why: a branch-keyed lookup can describe a different PR than the persisted
// linked review number. Track that distinction without changing the cache key.
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
