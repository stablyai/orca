// Why: Project mode rows carry a GitHub `owner/repo` slug, but Orca's
// `state.repos` stores only absolute paths. Before any repo-context action
// (opening the item dialog in repo-backed mode, launching a worktree) can
// dispatch correctly, we need a renderer-side index mapping slug → Repo[].
//
// The index is built lazily from `window.api.gh.repoSlug({ repoPath })` —
// the main-process resolver that reads `git remote` and classifies the
// remote into `owner/repo`. Repos whose slug cannot be resolved (no GitHub
// remote, SSH lookup failure) are excluded; the design doc (§Row actions)
// says to keep the unknown-repo fallback in that case.
//
// The index rebuilds only when `state.repos` changes — adding or removing
// a repo is rare enough that a full re-resolution is simpler than per-id
// invalidation, and the underlying IPC result is itself cached by the main
// process (`repoSlug` reads `.git/config`).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../shared/types'
import type { GlobalSettings } from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

/** Lowercased `owner/repo` → Repo[]. Case folded because GitHub treats slugs
 *  case-insensitively but displays the canonical casing; the lookup side
 *  uses the row's `content.repository` which may or may not match the
 *  canonical casing depending on when the project item was indexed. */
type SlugIndex = Map<string, Repo[]>

/** Module-scope cache keyed by runtime scope + repo.id. A Repo that has already failed
 *  resolution is not retried on re-mount; the value in the map is `null`
 *  to record the negative result so we don't keep poking `git remote` for
 *  repos that will never match. */
const slugByRepoId = new Map<string, string | null>()

function slugCacheKey(
  repoId: string,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  const target = getActiveRuntimeTarget(settings)
  return `${target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'}:${repoId}`
}

/** Drop a repo's cached slug result. Call when a repo is removed or its
 *  remote URL is known to have changed (e.g. after `git remote set-url`),
 *  so the next index build re-resolves rather than serving a stale entry. */
export function clearRepoSlugCacheEntry(repoId: string): void {
  for (const key of slugByRepoId.keys()) {
    if (key.endsWith(`:${repoId}`)) {
      slugByRepoId.delete(key)
    }
  }
}

/** Clear the entire slug cache. Useful for tests or full repo-list resets. */
export function clearRepoSlugCache(): void {
  slugByRepoId.clear()
}

async function resolveRepoSlug(
  repo: Repo,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<string | null> {
  const cacheKey = slugCacheKey(repo.id, settings)
  if (slugByRepoId.has(cacheKey)) {
    return slugByRepoId.get(cacheKey) ?? null
  }
  try {
    const target = getActiveRuntimeTarget(settings)
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<{ owner: string; repo: string } | null>(
            target,
            'github.repoSlug',
            { repo: repo.id },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.repoSlug({ repoPath: repo.path, repoId: repo.id })
    if (!result) {
      slugByRepoId.set(cacheKey, null)
      return null
    }
    const slug = `${result.owner}/${result.repo}`.toLowerCase()
    slugByRepoId.set(cacheKey, slug)
    return slug
  } catch {
    // Why: treat any IPC failure as "not resolvable" rather than propagating —
    // design doc §Row actions: "If gh:repoSlug fails for a repo, exclude it".
    slugByRepoId.set(cacheKey, null)
    return null
  }
}

async function buildIndex(
  repos: Repo[],
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<SlugIndex> {
  // Why: evict cached entries for repos that no longer exist in state so
  // the cache cannot grow unbounded across long sessions where users add
  // and remove repos. Without this, every removed repo's id (and its
  // negative-cached null) lingers forever.
  const liveKeys = new Set(repos.map((r) => slugCacheKey(r.id, settings)))
  for (const key of slugByRepoId.keys()) {
    if (!liveKeys.has(key)) {
      slugByRepoId.delete(key)
    }
  }
  const next: SlugIndex = new Map()
  const results = await Promise.all(
    repos.map(async (r) => ({ repo: r, slug: await resolveRepoSlug(r, settings) }))
  )
  for (const { repo, slug } of results) {
    if (slug) {
      next.set(slug, [...(next.get(slug) ?? []), repo])
    }
  }
  return next
}

/** Returns a lookup function `(slug) => Repo[]`. The lookup is stable
 *  across renders until `state.repos` changes; callers in deep trees can
 *  treat it as referentially equal inside a single render cycle. */
export function useRepoSlugIndex(): (slug: string | null | undefined) => Repo[] {
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const [index, setIndex] = useState<SlugIndex>(() => new Map())
  // Why: track the current repos snapshot so the effect can ignore stale
  // resolutions when repos change mid-flight.
  const generationRef = useRef(0)

  useEffect(() => {
    const gen = ++generationRef.current
    void buildIndex(repos, settings).then((next) => {
      if (gen !== generationRef.current) {
        return
      }
      setIndex(next)
    })
  }, [repos, settings])

  return useMemo(
    () =>
      (slug: string | null | undefined): Repo[] => {
        if (!slug) {
          return []
        }
        return index.get(slug.toLowerCase()) ?? []
      },
    [index]
  )
}
