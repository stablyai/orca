import type { ListComposition } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import type { GitHubTaskValueOrigin, GitHubTaskFamily } from '@/lib/github-task-observation'

import type { GitHubTaskObservation } from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

import type { ExecutionHostId } from '../../../../shared/execution-host'

import type { GitHubTaskRead } from './request-coordination'

import type { ClassifiedError } from '../../../../shared/classified-error'

import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'

import type { GitHubPRRefreshAlias } from '../../../../shared/github/pull-request-refresh-types'

import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'

import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type WorkItemsCacheSources = {
  ineligible?: true
  issues: GitHubOwnerRepo | null
  prs: GitHubOwnerRepo | null
  /** Raw origin remote, kept distinct from the effective PR source. */
  originCandidate: GitHubOwnerRepo | null
  /** Raw upstream remote, kept distinct from the effective issue source. */
  upstreamCandidate: GitHubOwnerRepo | null
}

export type WorkItemsCacheError = ClassifiedError & { source: GitHubOwnerRepo }

export type CacheEntry<T> = {
  fullFetchObservation?: GitHubTaskObservation
  data: T | null
  fetchedAt: number
  fetchedHeadOid?: string | null
  headSha?: string
  sources?: WorkItemsCacheSources
  error?: WorkItemsCacheError
  issueSourceFellBack?: true
}

export type FetchOptions = {
  taskRead?: GitHubTaskRead
  force?: boolean
  noCache?: boolean
  requireComplete?: boolean
  allowStaleFallback?: boolean
  sourceContext?: TaskSourceContext | null
  /** A Tasks Refresh/Retry or a single-repo open: a user act that may start a stopped WSL distro. */
  wakeWslDistro?: boolean
}

export type RepoScopedFetchOptions = FetchOptions & { repoId?: string }

export type GitHubPRFallbackSource = NonNullable<GitHubPRRefreshAlias['fallbackPRSource']>

export type ProjectViewCacheEntry<T> = {
  data: T | null
  fetchedAt: number
  error?: GitHubProjectViewError
}

export type ProjectRowContentUpdate = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type ProjectRowContentPatch = {
  title?: string
  body?: string
  state?: 'open' | 'closed' | 'merged' | 'draft'
  labels?: string[]
  assignees?: string[]
}

export type GitHubPatchWorkItemOptions = {
  listComposition?: readonly ListComposition[]
  observation?: GitHubTaskObservation
  valueOrigins?: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin | undefined>>
  sourceContexts?: readonly TaskSourceContext[]
  sourceContext?: TaskSourceContext | null
  ownerRepo?: GitHubOwnerRepo | null
  matches?: (item: GitHubWorkItem) => boolean
  hostId?: ExecutionHostId
}

export type GitHubWorkItemPatch = {
  itemId: string
  repoId: string
  patch: Partial<GitHubWorkItem>
  options?: Pick<
    GitHubPatchWorkItemOptions,
    'sourceContext' | 'observation' | 'ownerRepo' | 'valueOrigins' | 'listComposition'
  >
}
