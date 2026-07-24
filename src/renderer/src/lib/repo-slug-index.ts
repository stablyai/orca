// Project rows carry slugs while repo state carries paths, so repo-context
// actions need a lazily resolved slug → Repo[] index.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../shared/types'
import type { GlobalSettings } from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  clearRepoSlugCacheValues,
  deleteRepoSlugCacheKey,
  nextRepoSlugFailureRetryDelay,
  readRepoSlugCache,
  rememberRepoSlug,
  settingsForRepoOwner,
  slugByRepoId,
  slugCacheKey,
  type SlugIndex
} from './repo-slug-cache'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'
import { resolveRepoSlugsWithFixedWorkers } from './repo-slug-resolution-pool'

export { lookupReposBySlugFromCache } from './repo-slug-cache'
export { REPO_SLUG_RESOLUTION_CONCURRENCY } from './repo-slug-resolution-pool'

const slugResolutionInFlight = new Map<string, Promise<string | null>>()

const slugResolutionTokenByCacheKey = new Map<string, object>()

type RepoSlugResolver = (
  repo: Repo,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
) => Promise<string | null>

type RepoSlugIndexBuildResult = { index: SlugIndex; retryDelayMs: number | null }

let sharedIndexBuild:
  | {
      repos: readonly Repo[]
      settings: GlobalSettings | null | undefined
      resolver: RepoSlugResolver
      controller: AbortController
      promise: Promise<RepoSlugIndexBuildResult>
    }
  | undefined

function invalidateSlugResolution(cacheKey: string): void {
  slugResolutionInFlight.delete(cacheKey)
  slugResolutionTokenByCacheKey.delete(cacheKey)
}

// Why: clear after remove/remote-change so the next index build re-resolves.
export function clearRepoSlugCacheEntry(repoId: string): void {
  const suffix = `:${repoId}`
  // Why: an in-flight-only resolution has no `slugByRepoId` entry yet, so it
  // must be invalidated via the in-flight map too or its late write survives.
  const keys = new Set<string>()
  for (const key of slugByRepoId.keys()) {
    if (key.endsWith(suffix)) {
      keys.add(key)
    }
  }
  for (const key of slugResolutionInFlight.keys()) {
    if (key.endsWith(suffix)) {
      keys.add(key)
    }
  }
  for (const key of keys) {
    deleteRepoSlugCacheKey(key)
    invalidateSlugResolution(key)
  }
}

/** Clear the entire slug cache. Useful for tests or full repo-list resets. */
export function clearRepoSlugCache(): void {
  sharedIndexBuild?.controller.abort()
  sharedIndexBuild = undefined
  clearRepoSlugCacheValues()
  slugResolutionTokenByCacheKey.clear()
  slugResolutionInFlight.clear()
}

export function getRepoSlugResolutionStateSizesForTests(): {
  inFlight: number
  tokens: number
} {
  return {
    inFlight: slugResolutionInFlight.size,
    tokens: slugResolutionTokenByCacheKey.size
  }
}

async function resolveRepoSlug(
  repo: Repo,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<string | null> {
  const cacheKey = slugCacheKey(repo.id, settings)
  const cached = readRepoSlugCache(cacheKey)
  if (cached.hit) {
    return cached.value
  }
  const inFlight = slugResolutionInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const resolutionToken = {}
  slugResolutionTokenByCacheKey.set(cacheKey, resolutionToken)
  const resolution = (async () => {
    // Why: only write the resolved value if this key wasn't invalidated
    // mid-flight; otherwise a stale slug would repopulate the cache.
    const commit = (value: string | null): string | null => {
      if (slugResolutionTokenByCacheKey.get(cacheKey) === resolutionToken) {
        rememberRepoSlug(cacheKey, value)
      }
      return value
    }
    try {
      const target = getActiveRuntimeTarget(settings)
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ owner: string; repo: string; host?: string } | null>(
              target,
              'github.repoSlug',
              { repo: repo.id },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.repoSlug({ repoPath: repo.path, repoId: repo.id })
      if (!result) {
        return commit(null)
      }
      const slug = githubRepoIdentityKey(result)
      return commit(slug)
    } catch {
      // Why: GHES classification depends on auth that may change outside Orca;
      // retry negative results after a bounded quiet period instead of forever.
      return commit(null)
    }
  })()
  slugResolutionInFlight.set(cacheKey, resolution)
  try {
    return await resolution
  } finally {
    if (slugResolutionInFlight.get(cacheKey) === resolution) {
      slugResolutionInFlight.delete(cacheKey)
    }
    if (slugResolutionTokenByCacheKey.get(cacheKey) === resolutionToken) {
      slugResolutionTokenByCacheKey.delete(cacheKey)
    }
  }
}

function indexResolvedRepoSlugs(
  repos: readonly Repo[],
  slugs: readonly (string | null)[]
): SlugIndex {
  const index: SlugIndex = new Map()
  for (let repoIndex = 0; repoIndex < repos.length; repoIndex += 1) {
    const slug = slugs[repoIndex]
    if (slug) {
      const repo = repos[repoIndex]
      const matches = index.get(slug)
      if (matches) {
        matches.push(repo)
      } else {
        index.set(slug, [repo])
      }
    }
  }
  return index
}

/** @internal - fixed-worker regression coverage only. */
export async function buildRepoSlugIndexForTests(
  repos: readonly Repo[],
  resolver: (repo: Repo) => Promise<string | null>
): Promise<SlugIndex> {
  const slugs = await resolveRepoSlugsWithFixedWorkers(repos, resolver)
  return indexResolvedRepoSlugs(repos, slugs)
}

async function buildIndex(
  repos: Repo[],
  settings: GlobalSettings | null | undefined,
  resolver: RepoSlugResolver = resolveRepoSlug,
  signal?: AbortSignal
): Promise<RepoSlugIndexBuildResult> {
  // Why: evict cached entries for repos that no longer exist in state so
  // the cache cannot grow unbounded across long sessions where users add
  // and remove repos. Without this, every removed repo's id (and its
  // negative-cached null) lingers forever.
  const liveKeys = new Set<string>()
  for (const repo of repos) {
    liveKeys.add(slugCacheKey(repo.id, settingsForRepoOwner(repo, settings)))
  }
  for (const key of slugByRepoId.keys()) {
    if (!liveKeys.has(key)) {
      deleteRepoSlugCacheKey(key)
      invalidateSlugResolution(key)
    }
  }
  for (const key of slugResolutionInFlight.keys()) {
    if (!liveKeys.has(key)) {
      invalidateSlugResolution(key)
    }
  }
  // Why: repo fleets can be large; only a fixed number of IPC/RPC slug probes
  // should own promises and provider response buffers at once.
  const slugs = await resolveRepoSlugsWithFixedWorkers(
    repos,
    (repo) => resolver(repo, settingsForRepoOwner(repo, settings)),
    signal
  )
  const next = indexResolvedRepoSlugs(repos, slugs)
  return { index: next, retryDelayMs: nextRepoSlugFailureRetryDelay(liveKeys) }
}

function getSharedRepoSlugIndexBuild(
  repos: Repo[],
  settings: GlobalSettings | null | undefined,
  resolver: RepoSlugResolver
): Promise<RepoSlugIndexBuildResult> {
  if (
    sharedIndexBuild?.repos === repos &&
    sharedIndexBuild.settings === settings &&
    sharedIndexBuild.resolver === resolver
  ) {
    return sharedIndexBuild.promise
  }
  sharedIndexBuild?.controller.abort()
  const controller = new AbortController()
  const promise = buildIndex(repos, settings, resolver, controller.signal)
  const entry = { repos, settings, resolver, controller, promise }
  sharedIndexBuild = entry
  const release = (): void => {
    if (sharedIndexBuild === entry) {
      sharedIndexBuild = undefined
    }
  }
  void promise.then(release, release)
  return promise
}

/** @internal - shared-build regression coverage only. */
export function buildSharedRepoSlugIndexForTests(
  repos: Repo[],
  resolver: RepoSlugResolver
): Promise<SlugIndex> {
  return getSharedRepoSlugIndexBuild(repos, null, resolver).then((result) => result.index)
}

export type RepoSlugIndexState = {
  lookupSlug: (slug: string | null | undefined, host?: string) => Repo[]
  ready: boolean
}

/** Returns a slug lookup plus readiness for the current repo snapshot. The
 *  lookup is stable across renders until `state.repos` changes; callers in
 *  deep trees can treat it as referentially equal inside a single render cycle. */
export function useRepoSlugIndex(): RepoSlugIndexState {
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const [index, setIndex] = useState<SlugIndex>(() => new Map())
  const [ready, setReady] = useState(false)
  const [retryGeneration, setRetryGeneration] = useState(0)
  // Why: track the current repos snapshot so the effect can ignore stale
  // resolutions when repos change mid-flight.
  const generationRef = useRef(0)

  useEffect(() => {
    const gen = ++generationRef.current
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    setReady(false)
    void getSharedRepoSlugIndexBuild(repos, settings, resolveRepoSlug).then(
      ({ index: next, retryDelayMs }) => {
        if (gen !== generationRef.current) {
          return
        }
        setIndex(next)
        setReady(true)
        if (retryDelayMs !== null) {
          retryTimer = setTimeout(() => setRetryGeneration((value) => value + 1), retryDelayMs)
        }
      },
      () => {}
    )
    return () => {
      generationRef.current += 1
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
    }
  }, [repos, retryGeneration, settings])

  return useMemo(
    () => ({
      lookupSlug: (slug: string | null | undefined, host?: string): Repo[] => {
        const [owner, repo] = slug?.split('/') ?? []
        if (!owner || !repo) {
          return []
        }
        return index.get(githubRepoIdentityKey({ owner, repo, host })) ?? []
      },
      ready
    }),
    [index, ready]
  )
}
