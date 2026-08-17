import type {
  GitHubAssignableUser,
  GitHubPRFileViewedState
} from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { onGitHubWorkItemDetailsCacheMutation } from '@/lib/github-work-item-details-cache-events'

// SWR cache: reopening a drawer paints cached data instantly while a background refetch reconciles. See docs/gh-work-item-drawer-cache.md.
const WORK_ITEM_DETAILS_CACHE_MAX = 50
export const WORK_ITEM_DETAILS_FRESH_MS = 30_000
export const WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE = 'Unable to load details for this GitHub item.'
export type WorkItemDetailsCacheEntry = {
  details: GitHubWorkItemDetails | null
  fetchedAt: number
  pending?: Promise<GitHubWorkItemDetails | null>
  error?: string
}
export const workItemDetailsCache = new Map<string, WorkItemDetailsCacheEntry>()

// Why: useSyncExternalStore snapshot stability relies on every cache write replacing the entry object identity (delete+set).
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
  // Why: `\0` separator avoids collisions between key fields that may contain `:` or `/`.
  const keyParts = args.sourceCacheScope
    ? [args.repoId, args.sourceCacheScope, args.issueSourcePreference ?? 'auto', args.type]
    : [args.repoId, args.issueSourcePreference ?? 'auto', args.type]
  return [...keyParts, args.number].join('\0')
}

export function touchWorkItemDetailsCache(key: string, entry: WorkItemDetailsCacheEntry): void {
  // Why: re-insert moves the key to MRU; Map insertion order keeps the oldest key first when evicting.
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

// Why: object (not a number export) so cross-module readers always see later bumps after the split.
export const workItemDetailsCacheGeneration = { current: 0 }

// Exposed so mutation handlers can drop a stale entry after a local mutation (cross-window invalidation arrives via the `gh:workItemMutated` listener below).
export function invalidateWorkItemDetailsCacheForKey(key: string): void {
  // Why: bump generation so an in-flight fetch launched before this invalidation won't write its stale result back.
  workItemDetailsCacheGeneration.current += 1
  const existed = workItemDetailsCache.delete(key)
  if (existed) {
    notifyWorkItemDetailsCache()
  }
}

// Why: without the exact key (cross-window events carry only repoPath+number+type), drop every entry matching that tuple regardless of source preference.
export function invalidateWorkItemDetailsCacheByMatch(args: {
  repoPath: string
  repoId?: string
  type: 'issue' | 'pr'
  number: number
}): void {
  const suffix = `\0${args.type}\0${args.number}`
  const prefix = `${args.repoId ?? args.repoPath}\0`
  let removed = false
  for (const key of Array.from(workItemDetailsCache.keys())) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      workItemDetailsCache.delete(key)
      removed = true
    }
  }
  if (removed) {
    workItemDetailsCacheGeneration.current += 1
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

// Install once at module load (all dialogs share the cache); track the unsubscribe so Vite HMR doesn't accumulate listeners across reloads.
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
