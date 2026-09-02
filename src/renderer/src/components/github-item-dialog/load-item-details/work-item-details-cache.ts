import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type {
  GitHubAssignableUser,
  GitHubPRFileViewedState
} from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../../shared/github/work-item-types'
import { onGitHubWorkItemDetailsCacheMutation } from '@/lib/github-work-item-details-cache-events'

// Why: SWR cache for work-item details so reopening paints instantly instead of paying IPC + `gh` startup; keyed to avoid source/type collisions, LRU-bounded, FRESH_MS refetch on open. See docs/gh-work-item-drawer-cache.md.
export const WORK_ITEM_DETAILS_CACHE_MAX = 50
export const WORK_ITEM_DETAILS_FRESH_MS = 30_000
export const WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE = 'Unable to load details for this GitHub item.'
export type WorkItemDetailsCacheEntry = {
  details: GitHubWorkItemDetails | null
  fetchedAt: number
  pending?: Promise<GitHubWorkItemDetails | null>
  error?: string
}
export const workItemDetailsCache = new Map<string, WorkItemDetailsCacheEntry>()

// Why: drawers subscribe via useSyncExternalStore so a cached item paints synchronously; snapshot stability relies on every write replacing entry identity (delete+set).
const workItemDetailsCacheListeners = new Set<() => void>()
export function subscribeWorkItemDetailsCache(listener: () => void): () => void {
  workItemDetailsCacheListeners.add(listener)
  return () => {
    workItemDetailsCacheListeners.delete(listener)
  }
}
function notifyWorkItemDetailsCache(): void {
  for (const listener of workItemDetailsCacheListeners) {
    listener()
  }
}

export function getWorkItemDetailsCacheKey(args: {
  repoPath: string
  repoId: string
  issueSourcePreference: string | undefined
  sourceCacheScope?: string | null
  type: 'issue' | 'pr'
  number: number
}): string {
  // Why: key on every axis that changes which (repo, item) the IPC resolves to; `\0` separator avoids ambiguity with fields containing `:` or `/`.
  // Why: repoPath is the second part so match-based invalidation can find entries from a cross-window event that carries only the path.
  const keyParts = args.sourceCacheScope
    ? [
        args.repoId,
        args.repoPath,
        args.sourceCacheScope,
        args.issueSourcePreference ?? 'auto',
        args.type
      ]
    : [args.repoId, args.repoPath, args.issueSourcePreference ?? 'auto', args.type]
  return [...keyParts, args.number].join('\0')
}

export function touchWorkItemDetailsCache(key: string, entry: WorkItemDetailsCacheEntry): void {
  // Why: re-insert to move to MRU position; Map insertion order keeps the oldest key first for eviction.
  workItemDetailsCache.delete(key)
  workItemDetailsCache.set(key, entry)
  while (workItemDetailsCache.size > WORK_ITEM_DETAILS_CACHE_MAX) {
    const oldest = workItemDetailsCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    workItemDetailsCache.delete(oldest)
  }
  notifyWorkItemDetailsCache()
}

// Why: exposed so mutation handlers can drop a stale entry after a local mutation; cross-window invalidation arrives via the gh:workItemMutated listener below.
export function invalidateWorkItemDetailsCacheForKey(key: string): void {
  // Why: bump generation so a fetch launched before this invalidation won't write its stale result back.
  workItemDetailsCacheGeneration += 1
  const existed = workItemDetailsCache.delete(key)
  if (existed) {
    notifyWorkItemDetailsCache()
  }
}

// Why: bumped on every invalidation so an in-flight refetch started before a mutation can detect its result is stale and skip writing it back.
export let workItemDetailsCacheGeneration = 0

// Why: without the exact key (e.g. a cross-window event carries only repoPath+number+type), drop every entry matching that tuple regardless of source preference.
export function invalidateWorkItemDetailsCacheByMatch(args: {
  repoPath: string
  repoId?: string
  type: 'issue' | 'pr'
  number: number
}): void {
  if (!args.repoId && !args.repoPath) {
    // Why: an empty path would otherwise match every runtime-only entry of that type/number across repos.
    return
  }
  const suffix = `\0${args.type}\0${args.number}`
  let removed = false
  for (const key of Array.from(workItemDetailsCache.keys())) {
    if (!key.endsWith(suffix)) {
      continue
    }
    // Why: repoId identifies the entry exactly; repoPath is the only handle a cross-window event carries, so match either side of the key head.
    const [keyRepoId, keyRepoPath] = key.split('\0')
    const matches = args.repoId ? keyRepoId === args.repoId : keyRepoPath === args.repoPath
    if (matches) {
      workItemDetailsCache.delete(key)
      removed = true
    }
  }
  if (removed) {
    workItemDetailsCacheGeneration += 1
    notifyWorkItemDetailsCache()
  }
}

export function patchCachedPRFileViewedState(
  cacheKey: string,
  path: string,
  viewerViewedState: GitHubPRFileViewedState
): GitHubPRFileViewedState | undefined {
  const prev = workItemDetailsCache.get(cacheKey)
  const files = prev?.details?.files
  if (!prev?.details || !files) {
    return undefined
  }
  let previousState: GitHubPRFileViewedState | undefined
  const nextFiles = files.map((file) => {
    if (file.path !== path) {
      return file
    }
    previousState = file.viewerViewedState ?? 'UNVIEWED'
    return { ...file, viewerViewedState }
  })
  if (previousState === undefined || previousState === viewerViewedState) {
    return previousState
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: { ...prev.details, files: nextFiles },
    error: undefined
  })
  return previousState
}

export function patchCachedPRChecks(cacheKey: string, checks: PRCheckDetail[]): void {
  const prev = workItemDetailsCache.get(cacheKey)
  if (!prev?.details) {
    return
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: { ...prev.details, checks },
    fetchedAt: Date.now(),
    error: undefined
  })
}

export function patchCachedPRReviewRequests(
  cacheKey: string,
  reviewRequests: GitHubAssignableUser[]
): void {
  const prev = workItemDetailsCache.get(cacheKey)
  if (!prev?.details) {
    return
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: {
      ...prev.details,
      item: { ...prev.details.item, reviewRequests }
    },
    fetchedAt: Date.now(),
    error: undefined
  })
}

export function patchCachedWorkItemBody(cacheKey: string, body: string): void {
  const prev = workItemDetailsCache.get(cacheKey)
  if (!prev?.details) {
    return
  }
  touchWorkItemDetailsCache(cacheKey, {
    ...prev,
    details: { ...prev.details, body },
    fetchedAt: Date.now(),
    error: undefined
  })
}

// Why: install once — all dialogs share the cache; track unsubscribe so Vite HMR doesn't accumulate listeners across dev reloads.
let workItemMutatedUnsub: (() => void) | undefined
let workItemDetailsCacheEventUnsub: (() => void) | undefined
if (typeof window !== 'undefined' && window.api?.gh?.onWorkItemMutated) {
  workItemMutatedUnsub = window.api.gh.onWorkItemMutated((payload) => {
    invalidateWorkItemDetailsCacheByMatch({
      repoPath: payload.repoPath,
      repoId: payload.repoId,
      type: payload.type,
      number: payload.number
    })
  })
  workItemDetailsCacheEventUnsub = onGitHubWorkItemDetailsCacheMutation((payload) => {
    invalidateWorkItemDetailsCacheByMatch(payload)
  })
}
if (import.meta !== undefined && import.meta.hot) {
  import.meta.hot.dispose(() => {
    workItemMutatedUnsub?.()
    workItemDetailsCacheEventUnsub?.()
  })
}
