// Why: the slug → Repo cache and its synchronous lookup live here (separate from
// repo-slug-index.ts) so store slices can import the sync lookup without pulling
// in repo-slug-index's `@/store` dependency, which would form an import cycle.
import type { GlobalSettings, Repo } from '../../../shared/types'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForRepoRuntimeOwner } from './repo-runtime-owner'

/** Lowercased `owner/repo` → Repo[]. */
export type SlugIndex = Map<string, Repo[]>

/** Module-scope cache keyed by runtime scope + repo.id. A Repo that has already
 *  failed resolution is recorded as `null` so it is not retried on re-mount. */
export const slugByRepoId = new Map<string, string | null>()

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
  slug: string | null | undefined
): Repo[] {
  const target = slug?.toLowerCase()
  if (!target) {
    return []
  }
  const matched: Repo[] = []
  for (const repo of repos) {
    const cacheKey = slugCacheKey(repo.id, settingsForRepoOwner(repo, settings))
    if (slugByRepoId.get(cacheKey)?.toLowerCase() === target) {
      matched.push(repo)
    }
  }
  return matched
}
