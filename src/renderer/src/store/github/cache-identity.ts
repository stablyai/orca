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
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import { getGitHubPRCacheKey, getGitHubRepoCacheKey } from '../slices/github-cache-key'
import type { AppState } from '../types'
import { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
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

export function projectViewSourceScope(settings: AppState['settings']): string {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
}

export function settingsForProjectViewCacheKey(
  settings: AppState['settings'],
  cacheKey: string
): Pick<NonNullable<AppState['settings']>, 'activeRuntimeEnvironmentId'> {
  const runtimeMatch = /^github-project:runtime:([^:]+):/.exec(cacheKey)
  return runtimeMatch
    ? { ...settings, activeRuntimeEnvironmentId: runtimeMatch[1] }
    : { ...settings, activeRuntimeEnvironmentId: null }
}

export function workItemsCacheKey(
  repoId: string,
  limit: number,
  query: string,
  executionHostId?: string | null
): string {
  const scope = executionHostId?.trim() ?? ''
  const hostId = normalizeExecutionHostId(scope)
  const owner = `${repoId}::${limit}::${query}`
  if (hostId) {
    return hostId !== LOCAL_EXECUTION_HOST_ID ? `${hostId}::${owner}` : owner
  }
  return scope ? `${scope}::${owner}` : owner
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
    return `${getTaskSourceCacheScope(sourceContext)}::${repoId ?? repoPath}::${suffix}`
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

export function repoCacheKeyPrefixes(repoId: string, repoPath?: string): string[] {
  const prefixes = [`${repoId}::`]
  if (repoPath && repoPath !== repoId) {
    prefixes.push(`${repoPath}::`)
  }
  return prefixes
}

export function matchesRepoCacheKey(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix))
}

export function evictRepoCacheEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  prefixes: readonly string[]
): { cache: Record<string, CacheEntry<T>>; evicted: boolean } {
  let next: Record<string, CacheEntry<T>> | null = null
  for (const key of Object.keys(cache)) {
    if (!matchesRepoCacheKey(key, prefixes)) {
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
