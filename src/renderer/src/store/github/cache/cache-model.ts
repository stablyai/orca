import type { ClassifiedError } from '../../../../../shared/classified-error'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../../shared/github/repositories/repository-identity'
import type { GitHubPRRefreshAlias } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { GitHubProjectViewError } from '../../../../../shared/github/projects/project-result-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'

export type WorkItemsCacheSources = {
  ineligible?: true
  issues: GitHubOwnerRepo | null
  prs: GitHubOwnerRepo | null
  /** Raw origin remote, kept distinct from the effective PR source; absent when an older host didn't report it. */
  originCandidate?: GitHubOwnerRepo | null
  /** Raw upstream remote, kept distinct from the effective issue source; absent when an older host didn't report it. */
  upstreamCandidate?: GitHubOwnerRepo | null
}

export type WorkItemsCacheError = ClassifiedError & { source: GitHubOwnerRepo }

export type CacheEntry<T> = {
  data: T | null
  sourceBinding?: string
  collection?: { owner: number; limit: number; query: string; cacheScope: string | undefined }
  fetchedAt: number
  fetchedHeadOid?: string | null
  headSha?: string
  sources?: WorkItemsCacheSources
  error?: WorkItemsCacheError
  issueSourceFellBack?: true
}

export type FetchOptions = {
  force?: boolean
  noCache?: boolean
  requireComplete?: boolean
  allowStaleFallback?: boolean
  sourceContext?: TaskSourceContext | null
  /** A Tasks Refresh/Retry or a single-repo open: a user act that may start a stopped WSL distro. */
  wakeWslDistro?: boolean
}

export type RepoScopedFetchOptions = FetchOptions & {
  repoId?: string
  repoOwnerExecutionHostId?: string
}

export type GitHubPRFallbackSource = NonNullable<GitHubPRRefreshAlias['fallbackPRSource']>

export type ProjectViewCacheEntry<T> = {
  data: T | null
  fetchedAt: number
  error?: GitHubProjectViewError
}
