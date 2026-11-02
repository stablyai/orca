import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo,
  GitHubPRFileViewedState
} from '../../../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubWorkItemDetails } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { getGitHubSourceRuntimeHost } from '@/lib/github-source-runtime-context'
import { onGitHubWorkItemDetailsCacheMutation } from '@/lib/github-work-item-details-cache-events'

// Bound cached details for instant reopen; refresh stale entries on open. See docs/gh-work-item-drawer-cache.md.
export const WORK_ITEM_DETAILS_CACHE_MAX = 50
export const WORK_ITEM_DETAILS_FRESH_MS = 30_000
export const WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE = 'Unable to load details for this GitHub item.'
export type WorkItemDetailsCacheEntry = {
  details: GitHubWorkItemDetails | null
  fetchedAt: number
  pending?: Promise<GitHubWorkItemDetails | null>
  error?: string
  // Why: invalidation keeps the shown details (patches keep landing on them) but owes one fresh read; the read's start clears it.
  rereadOwed?: true
}
export const workItemDetailsCache = new Map<string, WorkItemDetailsCacheEntry>()

// Replace entry identity on every write so useSyncExternalStore snapshots stay stable between notifications.
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
  sourceContext?: TaskSourceContext | null
  type: 'issue' | 'pr'
  number: number
  ownerRepo?: GitHubOwnerRepo | null
}): string {
  // NUL-separate routing axes to prevent key collisions; keep repoPath second for path-only invalidation events.
  const sourceKey =
    args.ownerRepo && !getGitHubSourceRuntimeHost(args.sourceContext)
      ? githubRepoIdentityKey(args.ownerRepo)
      : (args.issueSourcePreference ?? 'auto')
  const keyParts = args.sourceCacheScope
    ? [args.repoId, args.repoPath, args.sourceCacheScope, sourceKey, args.type]
    : [args.repoId, args.repoPath, sourceKey, args.type]
  return [...keyParts, args.number].join('\0')
}

export function touchWorkItemDetailsCache(key: string, entry: WorkItemDetailsCacheEntry): void {
  // Reinsert as most recent; Map order supplies the eviction order.
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

export function invalidateWorkItemDetailsCacheForKey(key: string): void {
  workItemDetailsCacheGeneration += 1
  const existed = markWorkItemDetailsRereadOwed(key)
  if (existed) {
    notifyWorkItemDetailsCache()
  }
}

// Fence pending fetches on every invalidation so pre-mutation results cannot restore stale entries.
export let workItemDetailsCacheGeneration = 0

// Retire the pending read and owe one replacement read, keeping loaded details; an entry without details goes cold.
function markWorkItemDetailsRereadOwed(key: string): boolean {
  const prev = workItemDetailsCache.get(key)
  if (!prev) {
    return false
  }
  if (prev.details) {
    workItemDetailsCache.set(key, {
      details: prev.details,
      fetchedAt: prev.fetchedAt,
      rereadOwed: true
    })
  } else {
    workItemDetailsCache.delete(key)
  }
  return true
}

// Without an exact key, invalidate matching repo/type/number entries across source preferences.
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
    // Prefer repoId when supplied; path-only events match the key’s repository path.
    const [keyRepoId, keyRepoPath] = key.split('\0')
    const matches = args.repoId ? keyRepoId === args.repoId : keyRepoPath === args.repoPath
    if (matches) {
      markWorkItemDetailsRereadOwed(key)
      removed = true
    }
  }
  if (removed) {
    workItemDetailsCacheGeneration += 1
    notifyWorkItemDetailsCache()
  }
}

// Why: field writers change only the payload; the entry's request ownership (an owed reread, the current pending
// read) is copied by construction, so a local update can neither cancel nor orphan the whole-payload read.
function patchWorkItemDetailsPayload(
  key: string,
  update: (details: GitHubWorkItemDetails) => GitHubWorkItemDetails | null,
  fetchedAt?: number
): boolean {
  const prev = workItemDetailsCache.get(key)
  const details = prev?.details ? update(prev.details) : null
  if (!prev || !details) {
    return false
  }
  touchWorkItemDetailsCache(key, {
    details,
    fetchedAt: fetchedAt ?? prev.fetchedAt,
    pending: prev.pending,
    rereadOwed: prev.rereadOwed,
    error: undefined
  })
  return true
}

export function patchCachedPRFileViewedState(
  cacheKey: string,
  path: string,
  viewerViewedState: GitHubPRFileViewedState
): GitHubPRFileViewedState | undefined {
  let previousState: GitHubPRFileViewedState | undefined
  patchWorkItemDetailsPayload(cacheKey, (details) => {
    const files = details.files
    const file = files?.find((candidate) => candidate.path === path)
    if (!files || !file) {
      return null
    }
    previousState = file.viewerViewedState ?? 'UNVIEWED'
    if (previousState === viewerViewedState) {
      return null
    }
    return {
      ...details,
      files: files.map((candidate) =>
        candidate.path === path ? { ...candidate, viewerViewedState } : candidate
      )
    }
  })
  return previousState
}

export function patchCachedPRChecks(cacheKey: string, checks: PRCheckDetail[]): void {
  patchWorkItemDetailsPayload(cacheKey, (details) => ({ ...details, checks }), Date.now())
}

export function patchCachedPRReviewRequests(
  cacheKey: string,
  reviewRequests: GitHubAssignableUser[]
): void {
  patchWorkItemDetailsPayload(
    cacheKey,
    (details) => ({ ...details, item: { ...details.item, reviewRequests } }),
    Date.now()
  )
}

export function patchCachedWorkItemBody(cacheKey: string, body: string): void {
  patchWorkItemDetailsPayload(cacheKey, (details) => ({ ...details, body }), Date.now())
}

// Expire fetchedAt so a reopen refreshes server fields; a comment alone starts no read. False: nothing loaded or a duplicate.
export function appendCachedWorkItemComment(cacheKey: string, comment: PRComment): boolean {
  return patchWorkItemDetailsPayload(
    cacheKey,
    (details) =>
      details.comments.some((existing) => existing.id === comment.id)
        ? null
        : { ...details, comments: [...details.comments, comment] },
    0
  )
}

// Share event listeners across dialogs and unsubscribe on HMR to avoid accumulating subscriptions.
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
