// Index project owner/repo slugs to path-backed Repo rows lazily via owner-routed gh.repoSlug. Exclude unresolved repos and retain unknown-repo fallback; rebuild on catalog changes, with cached main-process remote resolution.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  deleteRepoSlugCacheKey,
  nextRepoSlugFailureRetryDelay,
  readRepoSlugCache,
  rememberRepoSlug,
  repoSlugCacheKey,
  repoSlugOwnerTarget,
  repoUpstreamIdentityKey,
  slugByRepoId,
  slugCacheKey,
  type RepoSlugMatches,
  type SlugIndex
} from './repo-slug-cache'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { createBoundedGenerationMap } from './bounded-generation-map'

export { lookupReposBySlugFromCache } from './repo-slug-cache'

const slugResolutionInFlight = new Map<string, Promise<string | null>>()

// Invalidation cannot cancel in-flight writes; gate cache commits by key generation so removed/changed slugs cannot repopulate.
const slugResolutionGenerations = createBoundedGenerationMap(1024)

function invalidateSlugResolution(cacheKey: string): void {
  slugResolutionInFlight.delete(cacheKey)
  slugResolutionGenerations.advance(cacheKey)
}

export function clearRepoSlugCacheEntry(repoId: string): void {
  const suffix = `:${repoId}`
  // Invalidate in-flight-only keys too; they have no cached entry yet but can still write stale results.
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

export async function resolveRepoSlug(repo: Repo): Promise<string | null> {
  // The index spans hosts; read each repo’s remote metadata from its owner.
  const target = repoSlugOwnerTarget(repo)
  if (!target) {
    return null
  }
  const cacheKey = slugCacheKey(repo.id, target)
  const cached = readRepoSlugCache(cacheKey)
  if (cached.hit) {
    return cached.value
  }
  const inFlight = slugResolutionInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const generation = slugResolutionGenerations.get(cacheKey)
  const resolution = (async () => {
    // Commit only the generation that started this resolution; invalidation makes late results stale.
    const commit = (value: string | null): string | null => {
      if (
        slugResolutionInFlight.get(cacheKey) === resolution &&
        slugResolutionGenerations.get(cacheKey) === generation
      ) {
        rememberRepoSlug(cacheKey, value)
      }
      return value
    }
    try {
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
      // GHES auth can change outside Orca; retry negative results after a bounded quiet period.
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
  }
}

async function buildIndex(
  repos: readonly Repo[]
): Promise<{ index: SlugIndex; upstreamIndex: SlugIndex; retryDelayMs: number | null }> {
  // Prune removed repo IDs, including negative entries, to bound cache growth across long sessions.
  const liveKeys = new Set(repos.flatMap((r) => repoSlugCacheKey(r) ?? []))
  for (const key of slugByRepoId.keys()) {
    if (!liveKeys.has(key)) {
      deleteRepoSlugCacheKey(key)
      invalidateSlugResolution(key)
    }
  }
  const next: SlugIndex = new Map()
  const upstreamNext: SlugIndex = new Map()
  const results = await Promise.all(
    repos.map(async (r) => ({
      repo: r,
      slug: await resolveRepoSlug(r)
    }))
  )
  for (const { repo, slug } of results) {
    if (slug) {
      next.set(slug, [...(next.get(slug) ?? []), repo])
    }
    // Project rows name upstream but contributor clones use fork origins; add pre-resolved upstream aliases without extra IPC (#12647).
    const upstreamKey = repoUpstreamIdentityKey(repo, slug)
    if (upstreamKey && upstreamKey !== slug) {
      upstreamNext.set(upstreamKey, [...(upstreamNext.get(upstreamKey) ?? []), repo])
    }
  }
  return {
    index: next,
    upstreamIndex: upstreamNext,
    retryDelayMs: nextRepoSlugFailureRetryDelay(liveKeys)
  }
}

export type RepoSlugIndexState = {
  /** Best available matches: origin when anything owns the slug, else forks. */
  lookupSlug: (slug: string | null | undefined, host?: string) => Repo[]
  lookupSlugMatches: (slug: string | null | undefined, host?: string) => RepoSlugMatches
  ready: boolean
}

/** Return slug lookup/readiness for the current repo snapshot; preserve lookup identity until repos change. */
export function useRepoSlugIndex(): RepoSlugIndexState {
  const repos = useAppStore((s) => s.repos)
  const [index, setIndex] = useState<SlugIndex>(() => new Map())
  const [upstreamIndex, setUpstreamIndex] = useState<SlugIndex>(() => new Map())
  const [ready, setReady] = useState(false)
  const [retryGeneration, setRetryGeneration] = useState(0)
  // Own retry timers synchronously in a dedicated effect; async assignment hid cleanup from react-doctor.
  const [retryDelayMs, setRetryDelayMs] = useState<number | null>(null)
  // Ignore resolutions from obsolete repo snapshots.
  const generationRef = useRef(0)

  useEffect(() => {
    const gen = ++generationRef.current
    setReady(false)
    setRetryDelayMs(null)
    void buildIndex(repos).then(
      ({ index: next, upstreamIndex: nextUpstream, retryDelayMs: nextRetryDelayMs }) => {
        if (gen !== generationRef.current) {
          return
        }
        setIndex(next)
        setUpstreamIndex(nextUpstream)
        setReady(true)
        setRetryDelayMs(nextRetryDelayMs)
      }
    )
    return () => {
      generationRef.current += 1
    }
  }, [repos, retryGeneration])

  useEffect(() => {
    if (retryDelayMs === null) {
      return
    }
    const retryTimer = setTimeout(() => setRetryGeneration((value) => value + 1), retryDelayMs)
    return () => {
      clearTimeout(retryTimer)
    }
  }, [retryDelayMs])

  return useMemo(() => {
    const lookupSlugMatches = (slug: string | null | undefined, host?: string): RepoSlugMatches => {
      const [owner, repo] = slug?.split('/') ?? []
      if (!owner || !repo) {
        return { origin: [], upstream: [] }
      }
      const key = githubRepoIdentityKey({ owner, repo, host })
      return { origin: index.get(key) ?? [], upstream: upstreamIndex.get(key) ?? [] }
    }
    return {
      lookupSlugMatches,
      // Prefer origin clones over forks; selection-filtered callers use lookupSlugMatches so unselected upstreams cannot shadow selected forks.
      lookupSlug: (slug: string | null | undefined, host?: string): Repo[] => {
        const { origin, upstream } = lookupSlugMatches(slug, host)
        return origin.length > 0 ? origin : upstream
      },
      ready
    }
  }, [index, upstreamIndex, ready])
}
