import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getSettingsFocusedExecutionHostId,
  normalizeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'

export type LinkedReviewHints = {
  linkedGitHubPR?: number | null
  /** Repository of a URL-linked GitHub PR outside this repo; see getLinkedGitHubPRRepository. */
  linkedGitHubPRRepository?: GitHubOwnerRepo | null
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

/** The hint a resolved GitHub PR answers, matching the request that linked it. */
export function githubPRHintKey(
  pr: { number: number; linkedFromOtherRepository?: boolean },
  repository: GitHubOwnerRepo | undefined
): string {
  return linkedReviewHintKey({
    linkedGitHubPR: pr.number,
    ...(pr.linkedFromOtherRepository && repository ? { linkedGitHubPRRepository: repository } : {})
  })
}

// Why: a branch-keyed lookup can describe a different PR than the persisted
// linked review number. Track that distinction without changing the cache key.
export function linkedReviewHintKey(options?: LinkedReviewHints): string {
  const github = options?.linkedGitHubPR ?? options?.fallbackGitHubPR ?? null
  // Why: the same number in another repository is a different PR.
  const githubRepository =
    options?.linkedGitHubPR != null && options.linkedGitHubPRRepository
      ? `${githubRepoIdentityKey(options.linkedGitHubPRRepository)}#`
      : ''
  const hints = [
    ['github', github === null ? null : `${githubRepository}${github}`],
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
