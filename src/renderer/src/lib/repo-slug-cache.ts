// Keep synchronous slug cache separate from repo-slug-index so store callers avoid its @/store import cycle.
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeTargetForRepoOwner } from './repo-runtime-owner'
import {
  githubHostFromIdentityKey,
  githubRepoIdentityKey
} from '../../../shared/github/repository-identity-key'

/** Lowercased `owner/repo` → Repo[]. */
export type SlugIndex = Map<string, Repo[]>

/** Keep origin/upstream matches separate so selection-filtered callers can use a fork when an unselected upstream clone exists. */
export type RepoSlugMatches = { origin: Repo[]; upstream: Repo[] }

/** Fork-parent alias, or null if untrusted. Require resolved origin identity as host fallback for older upstream metadata, or GHES parents could collapse into github.com. */
export function repoUpstreamIdentityKey(
  repo: Repo,
  originIdentityKey: string | null | undefined
): string | null {
  const upstream = repo.upstream
  if (!upstream?.owner || !upstream.repo || !originIdentityKey) {
    return null
  }
  return githubRepoIdentityKey({
    ...upstream,
    host: upstream.host ?? githubHostFromIdentityKey(originIdentityKey)
  })
}

/** Cache by runtime scope/repo ID, briefly retaining null failures to avoid per-cell retries while recovering after external GHES login. */
export const slugByRepoId = new Map<string, string | null>()
const slugFailureExpiresAtByRepoId = new Map<string, number>()
export const REPO_SLUG_FAILURE_TTL_MS = 60_000

export function readRepoSlugCache(
  cacheKey: string,
  now = Date.now()
): { hit: true; value: string | null } | { hit: false } {
  if (!slugByRepoId.has(cacheKey)) {
    return { hit: false }
  }
  const value = slugByRepoId.get(cacheKey) ?? null
  const failureExpiry = slugFailureExpiresAtByRepoId.get(cacheKey)
  if (value !== null || failureExpiry === undefined || failureExpiry > now) {
    return { hit: true, value }
  }
  slugByRepoId.delete(cacheKey)
  slugFailureExpiresAtByRepoId.delete(cacheKey)
  return { hit: false }
}

export function rememberRepoSlug(cacheKey: string, value: string | null, now = Date.now()): void {
  slugByRepoId.set(cacheKey, value)
  if (value === null) {
    slugFailureExpiresAtByRepoId.set(cacheKey, now + REPO_SLUG_FAILURE_TTL_MS)
  } else {
    slugFailureExpiresAtByRepoId.delete(cacheKey)
  }
}

export function deleteRepoSlugCacheKey(cacheKey: string): void {
  slugByRepoId.delete(cacheKey)
  slugFailureExpiresAtByRepoId.delete(cacheKey)
}

export function clearRepoSlugCacheValues(): void {
  slugByRepoId.clear()
  slugFailureExpiresAtByRepoId.clear()
}

export function nextRepoSlugFailureRetryDelay(
  cacheKeys: ReadonlySet<string>,
  now = Date.now()
): number | null {
  let earliestExpiry = Number.POSITIVE_INFINITY
  for (const cacheKey of cacheKeys) {
    if (slugByRepoId.get(cacheKey) !== null) {
      continue
    }
    const expiresAt = slugFailureExpiresAtByRepoId.get(cacheKey)
    if (expiresAt !== undefined) {
      earliestExpiry = Math.min(earliestExpiry, expiresAt)
    }
  }
  return Number.isFinite(earliestExpiry) ? Math.max(0, earliestExpiry - now) : null
}

export function slugCacheKey(repoId: string, target: RuntimeClientTarget): string {
  return `${target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'}:${repoId}`
}

/** A repo's remote metadata is read from the host that owns the row; `null` when no host does. */
export function repoSlugOwnerTarget(repo: Repo): RuntimeClientTarget | null {
  return runtimeTargetForRepoOwner({ repos: [repo] }, repo.id)
}

/** The slug cache key for a repo on its owner, or `null` when the row names no routable host. */
export function repoSlugCacheKey(repo: Repo): string | null {
  const target = repoSlugOwnerTarget(repo)
  return target ? slugCacheKey(repo.id, target) : null
}

/** Synchronous owner-routing lookup for store callers that cannot use the async index. Fall back to source host on misses; origin beats forks so upstream clones remain unambiguous. */
export function lookupReposBySlugFromCache(
  repos: readonly Repo[],
  slug: string | null | undefined,
  host?: string
): Repo[] {
  const [owner, repo] = slug?.split('/') ?? []
  if (!owner || !repo) {
    return []
  }
  const target = githubRepoIdentityKey({ owner, repo, host })
  const matched: Repo[] = []
  const upstreamMatched: Repo[] = []
  for (const repo of repos) {
    const cacheKey = repoSlugCacheKey(repo)
    const originKey = cacheKey ? slugByRepoId.get(cacheKey) : undefined
    if (originKey === target) {
      matched.push(repo)
    } else if (repoUpstreamIdentityKey(repo, originKey) === target) {
      upstreamMatched.push(repo)
    }
  }
  return matched.length > 0 ? matched : upstreamMatched
}
