// Why: the slug → Repo cache and its synchronous lookup live here (separate from
// repo-slug-index.ts) so store slices can import the sync lookup without pulling
// in repo-slug-index's `@/store` dependency, which would form an import cycle.
import type { GlobalSettings, Repo } from '../../../shared/types'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForRepoRuntimeOwner } from './repo-runtime-owner'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'

/** Lowercased `owner/repo` → Repo[]. */
export type SlugIndex = Map<string, Repo[]>

/** Module-scope cache keyed by runtime scope + repo.id. A Repo that has already
 *  failed resolution is recorded as `null` briefly so it is not retried on every
 *  cell mount, while still recovering after an external GHES auth login. */
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

export function slugCacheKey(
  repoId: string,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  const target = getActiveRuntimeTarget(settings)
  return `${target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'}:${repoId}`
}

export function settingsForRepoOwner(
  repo: Repo,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  return getSettingsForRepoRuntimeOwner({ repos: [repo], settings }, repo.id)
}

/** Synchronous slug → Repo lookup against the already-resolved module cache.
 *  Used by store slices (which can't run the async hook-based index) to route
 *  project-row mutations to the matched repo's owner host; callers fall back to
 *  focused settings when nothing matches. */
export function lookupReposBySlugFromCache(
  repos: readonly Repo[],
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  slug: string | null | undefined,
  host?: string
): Repo[] {
  const [owner, repo] = slug?.split('/') ?? []
  if (!owner || !repo) {
    return []
  }
  const target = githubRepoIdentityKey({ owner, repo, host })
  const matched: Repo[] = []
  for (const repo of repos) {
    const cacheKey = slugCacheKey(repo.id, settingsForRepoOwner(repo, settings))
    if (slugByRepoId.get(cacheKey) === target) {
      matched.push(repo)
    }
  }
  return matched
}
