import type { GlobalSettings } from '../../../../shared/types'

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
  connectionId?: string | null
): string {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  const sshConnectionId = connectionId?.trim()
  const scope = environmentId
    ? `runtime:${environmentId}`
    : sshConnectionId
      ? `ssh:${sshConnectionId}`
      : 'local'
  return `${scope}::${repoId ?? repoPath}::${branch}`
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
