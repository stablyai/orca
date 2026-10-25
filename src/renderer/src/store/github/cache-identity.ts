import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { githubProjectIdentityKey } from '../../../../shared/github/project-identity'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { GetProjectViewTableArgs } from '../../../../shared/github/project-request-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  composeRepoCacheKey,
  getGitHubPRCacheKey,
  getGitHubRepoCacheKey,
  repoCacheKeyHostId
} from '../../../../shared/github/github-cache-key'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { CacheEntry } from './cache-model'

function queryOverrideKeyPart(queryOverride: string | undefined): string {
  return queryOverride === undefined ? '' : `:q=${queryOverride}`
}

export function projectViewCacheKey(
  ownerType: GetProjectViewTableArgs['ownerType'],
  owner: string,
  projectNumber: number,
  resolvedViewId: string,
  queryOverride?: string,
  sourceScope = 'local',
  host?: string
): string {
  const projectKey = githubProjectIdentityKey({ ownerType, owner, number: projectNumber, host })
  return `github-project:${sourceScope}:${projectKey}:${resolvedViewId}${queryOverrideKeyPart(queryOverride)}`
}

export function projectViewRequestKey(args: GetProjectViewTableArgs, sourceScope: string): string {
  const selector = args.viewId
    ? `id:${args.viewId}`
    : args.viewNumber !== undefined
      ? `num:${args.viewNumber}`
      : args.viewName
        ? `name:${args.viewName}`
        : 'default'
  const projectKey = githubProjectIdentityKey({
    ownerType: args.ownerType,
    owner: args.owner,
    number: args.projectNumber,
    host: args.host
  })
  return `${sourceScope}:${projectKey}:${selector}${queryOverrideKeyPart(args.queryOverride)}`
}

export function projectViewSourceScope(target: RuntimeClientTarget): string {
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
}

/** The host a board row was loaded from, read back from the scope written into its cache key. */
export function projectViewCacheKeyTarget(cacheKey: string): RuntimeClientTarget {
  const runtimeMatch = /^github-project:runtime:([^:]+):/.exec(cacheKey)
  return runtimeMatch ? { kind: 'environment', environmentId: runtimeMatch[1] } : { kind: 'local' }
}

export function workItemsCacheKey(
  repoId: string,
  limit: number,
  query: string,
  executionHostId?: string | null
): string {
  const scope = executionHostId?.trim() ?? ''
  const hostId = normalizeExecutionHostId(scope)
  return composeRepoCacheKey(
    hostId ? (hostId !== LOCAL_EXECUTION_HOST_ID ? hostId : null) : scope,
    repoId,
    `${limit}::${query}`
  )
}

export function workItemsInflightRequestKey(
  cacheKey: string,
  target: { kind: 'environment'; environmentId: string; runtimeRepoId: string } | { kind: 'local' }
): string {
  const targetPart =
    target.kind === 'environment' ? `env:${target.environmentId}:${target.runtimeRepoId}` : 'local'
  return `${cacheKey}::${targetPart}`
}

export function issueCacheKey(
  repoPath: string,
  repoId: string | undefined,
  issueNumber: number | string,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string {
  return getGitHubRepoCacheKey(
    repoPath,
    repoId,
    String(issueNumber),
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
}

export function runtimeScopedRepoCacheKey(
  repoPath: string,
  repoId: string | undefined,
  suffix: string,
  settings?: AppState['settings'],
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string {
  return getGitHubRepoCacheKey(
    repoPath,
    repoId,
    suffix,
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
}

export function sourceScopedRepoCacheKey(
  repoPath: string,
  repoId: string | undefined,
  suffix: string,
  settings?: AppState['settings'],
  connectionId?: string | null,
  executionHostId?: string | null,
  sourceContext?: TaskSourceContext | null,
  hasRepoOwner = false
): string {
  if (sourceContext?.provider === 'github') {
    return composeRepoCacheKey(getTaskSourceCacheScope(sourceContext), repoId ?? repoPath, suffix)
  }
  return runtimeScopedRepoCacheKey(
    repoPath,
    repoId,
    suffix,
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
}

export function prCacheKey(
  repoPath: string,
  repoId: string | undefined,
  branch: string,
  settings?: AppState['settings'],
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): string {
  return getGitHubPRCacheKey(
    repoPath,
    repoId,
    branch,
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
}

/** A repo's cache entries to drop: every host's bucket except a surviving same-id twin's. */
export type RepoCacheEviction = {
  owners: readonly string[]
  keptHostIds: ReadonlySet<ExecutionHostId>
}

export function repoCacheEviction(
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[],
  repoId: string,
  repoPath: string | undefined,
  evictedHostId: ExecutionHostId | null
): RepoCacheEviction {
  const owners = repoPath && repoPath !== repoId ? [repoId, repoPath] : [repoId]
  const keptHostIds = new Set<ExecutionHostId>()
  // Why: with no known host to evict, every bucket for the id may be the stale one.
  if (evictedHostId) {
    for (const repo of repos) {
      const hostId = getRepoExecutionHostId(repo)
      if (repo.id === repoId && hostId !== evictedHostId) {
        keptHostIds.add(hostId)
      }
    }
  }
  return { owners, keptHostIds }
}

export function matchesRepoCacheEviction(key: string, eviction: RepoCacheEviction): boolean {
  const hostId = repoCacheKeyHostId(key, eviction.owners)
  return hostId !== null && !eviction.keptHostIds.has(hostId)
}

export function evictRepoCacheEntries<V>(
  cache: Record<string, V>,
  eviction: RepoCacheEviction
): { cache: Record<string, V>; evicted: boolean } {
  let next: Record<string, V> | null = null
  for (const key of Object.keys(cache)) {
    if (!matchesRepoCacheEviction(key, eviction)) {
      continue
    }
    next ??= { ...cache }
    delete next[key]
  }
  return next ? { cache: next, evicted: true } : { cache, evicted: false }
}

function normalizedHeadSha(headSha?: string): string | null {
  const trimmed = headSha?.trim()
  return trimmed ? trimmed.toLowerCase() : null
}

export function prChecksCacheSuffix(
  prNumber: number,
  prRepo?: GitHubOwnerRepo | null,
  headSha?: string
): string {
  const headSuffix = normalizedHeadSha(headSha)
  const base = prRepo
    ? `pr-checks::${githubRepoIdentityKey(prRepo)}::${prNumber}`
    : `pr-checks::${prNumber}`
  return headSuffix ? `${base}::head::${headSuffix}` : base
}

export function prCommentsCacheSuffix(prNumber: number, prRepo?: GitHubOwnerRepo | null): string {
  return prRepo
    ? `pr-comments::${githubRepoIdentityKey(prRepo)}::${prNumber}`
    : `pr-comments::${prNumber}`
}

export function getPRChecksCacheTtl(entry: CacheEntry<PRCheckDetail[]> | undefined): number {
  return entry?.data?.length === 0 ? 10_000 : 60_000
}
