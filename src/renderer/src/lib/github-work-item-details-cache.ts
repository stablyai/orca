import type { GitHubWorkItemDetails } from '../../../shared/types'
import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  onGitHubWorkItemDetailsCacheMutation,
  type GitHubWorkItemDetailsCacheMutation
} from './github-work-item-details-cache-events'
import { measureWorkItemDetailsCacheEntryBytes } from './github-work-item-details-retained-bytes'

export const WORK_ITEM_DETAILS_CACHE_MAX = 50
export const WORK_ITEM_DETAILS_CACHE_MAX_AGGREGATE_BYTES = 32 * 1024 * 1024
export const WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES = 16 * 1024 * 1024
export const WORK_ITEM_DETAILS_CACHE_MAX_KEY_BYTES = 4 * 1024
export const WORK_ITEM_DETAILS_FRESH_MS = 30_000
export const WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE = 'Unable to load details for this GitHub item.'

export type WorkItemDetailsCacheEntry = {
  details: GitHubWorkItemDetails | null
  fetchedAt: number
  pending?: Promise<GitHubWorkItemDetails | null>
  error?: string
}

type WorkItemDetailsCacheLimits = {
  maxEntries: number
  maxAggregateBytes: number
  maxValueBytes: number
  maxKeyBytes: number
}

type WorkItemDetailsCacheActivity =
  | { type: 'write'; key: string; entry: WorkItemDetailsCacheEntry; retained: boolean }
  | { type: 'invalidate-key'; key: string }
  | { type: 'invalidate-match'; match: GitHubWorkItemDetailsCacheMutation }

const DEFAULT_LIMITS: WorkItemDetailsCacheLimits = {
  maxEntries: WORK_ITEM_DETAILS_CACHE_MAX,
  maxAggregateBytes: WORK_ITEM_DETAILS_CACHE_MAX_AGGREGATE_BYTES,
  maxValueBytes: WORK_ITEM_DETAILS_CACHE_MAX_VALUE_BYTES,
  maxKeyBytes: WORK_ITEM_DETAILS_CACHE_MAX_KEY_BYTES
}

export function createWorkItemDetailsCacheController(
  overrides: Partial<WorkItemDetailsCacheLimits> = {}
) {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const entries = new Map<string, { entry: WorkItemDetailsCacheEntry; bytes: number }>()
  let retainedBytes = 0
  const remove = (key: string): boolean => {
    const existing = entries.get(key)
    if (!existing) {
      return false
    }
    retainedBytes -= existing.bytes
    return entries.delete(key)
  }
  const evictOldest = (): void => {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) {
      remove(oldest)
    }
  }
  return {
    get: (key) => {
      const retained = entries.get(key)
      if (!retained) {
        return undefined
      }
      entries.delete(key)
      entries.set(key, retained)
      return retained.entry
    },
    set: (key, entry) => {
      remove(key)
      const keyBytes = measureUtf8ByteLength(key, { stopAfterBytes: limits.maxKeyBytes })
      if (keyBytes.exceededLimit) {
        return false
      }
      const valueBytes = measureWorkItemDetailsCacheEntryBytes(entry, limits.maxValueBytes)
      if (valueBytes === null || keyBytes.byteLength + valueBytes > limits.maxAggregateBytes) {
        return false
      }
      const bytes = keyBytes.byteLength + valueBytes
      entries.set(key, { entry, bytes })
      retainedBytes += bytes
      while (entries.size > limits.maxEntries || retainedBytes > limits.maxAggregateBytes) {
        evictOldest()
      }
      return entries.get(key)?.entry === entry
    },
    delete: remove,
    deleteMatching: (predicate) => {
      const removed: string[] = []
      for (const key of entries.keys()) {
        if (predicate(key) && remove(key)) {
          removed.push(key)
        }
      }
      return removed
    },
    clear: () => {
      entries.clear()
      retainedBytes = 0
    },
    getRetainedBytes: () => retainedBytes,
    getSize: () => entries.size
  }
}

const sharedCache = createWorkItemDetailsCacheController()
const cacheListeners = new Set<() => void>()
const activityListeners = new Set<(activity: WorkItemDetailsCacheActivity) => boolean | void>()
let cacheGeneration = 0

function notifyCache(): void {
  for (const listener of cacheListeners) {
    listener()
  }
}

function emitActivity(activity: WorkItemDetailsCacheActivity): boolean {
  let matched = false
  for (const listener of activityListeners) {
    matched = listener(activity) === true || matched
  }
  return matched
}

export function getWorkItemDetailsCacheKey(args: {
  repoPath: string
  repoId: string
  issueSourcePreference: string | undefined
  sourceCacheScope?: string | null
  type: 'issue' | 'pr'
  number: number
}): string {
  const keyParts = args.sourceCacheScope
    ? [args.repoId, args.sourceCacheScope, args.issueSourcePreference ?? 'auto', args.type]
    : [args.repoId, args.issueSourcePreference ?? 'auto', args.type]
  return [...keyParts, args.number].join('\0')
}

export function getWorkItemDetailsCacheEntry(key: string): WorkItemDetailsCacheEntry | undefined {
  return sharedCache.get(key)
}

export function touchWorkItemDetailsCache(key: string, entry: WorkItemDetailsCacheEntry): boolean {
  const retained = sharedCache.set(key, entry)
  emitActivity({ type: 'write', key, entry, retained })
  notifyCache()
  return retained
}

export function subscribeWorkItemDetailsCache(listener: () => void): () => void {
  cacheListeners.add(listener)
  return () => cacheListeners.delete(listener)
}

export function subscribeWorkItemDetailsCacheActivity(
  listener: (activity: WorkItemDetailsCacheActivity) => boolean | void
): () => void {
  activityListeners.add(listener)
  return () => activityListeners.delete(listener)
}

export function getWorkItemDetailsCacheGeneration(): number {
  return cacheGeneration
}

export function matchesWorkItemDetailsCacheInvalidation(
  key: string,
  args: GitHubWorkItemDetailsCacheMutation
): boolean {
  const prefix = `${args.repoId ?? args.repoPath}\0`
  return key.startsWith(prefix) && key.endsWith(`\0${args.type}\0${args.number}`)
}

export function useWorkItemDetailsCacheEntry(
  key: string | null
): WorkItemDetailsCacheEntry | undefined {
  const retainedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(() => (key ? getWorkItemDetailsCacheEntry(key) : undefined), [key])
  )
  const unretainedRef = useRef<{ key: string; entry: WorkItemDetailsCacheEntry } | null>(null)
  const lastKeyRef = useRef(key)
  const [, setRevision] = useState(0)
  if (lastKeyRef.current !== key) {
    lastKeyRef.current = key
    unretainedRef.current = null
  }
  useEffect(
    () =>
      subscribeWorkItemDetailsCacheActivity((activity) => {
        if (!key) {
          return false
        }
        if (activity.type === 'write' && activity.key === key) {
          unretainedRef.current = activity.retained ? null : { key, entry: activity.entry }
          setRevision((current) => current + 1)
          return false
        }
        const invalidated =
          (activity.type === 'invalidate-key' && activity.key === key) ||
          (activity.type === 'invalidate-match' &&
            matchesWorkItemDetailsCacheInvalidation(key, activity.match))
        if (!invalidated) {
          return false
        }
        const hadUnretainedEntry = unretainedRef.current?.key === key
        unretainedRef.current = null
        setRevision((current) => current + 1)
        return hadUnretainedEntry
      }),
    [key]
  )
  return (
    retainedEntry ?? (unretainedRef.current?.key === key ? unretainedRef.current.entry : undefined)
  )
}

export function invalidateWorkItemDetailsCacheForKey(key: string): void {
  cacheGeneration += 1
  const existed = sharedCache.delete(key)
  emitActivity({ type: 'invalidate-key', key })
  if (existed) {
    notifyCache()
  }
}

export function invalidateWorkItemDetailsCacheByMatch(
  args: GitHubWorkItemDetailsCacheMutation
): void {
  const removed = sharedCache.deleteMatching((key) =>
    matchesWorkItemDetailsCacheInvalidation(key, args)
  )
  const transientMatched = emitActivity({ type: 'invalidate-match', match: args })
  if (removed.length > 0 || transientMatched) {
    cacheGeneration += 1
  }
  if (removed.length > 0) {
    notifyCache()
  }
}

export function clearWorkItemDetailsCacheForTests(): void {
  sharedCache.clear()
  cacheGeneration = 0
  notifyCache()
}

let workItemMutatedUnsub: (() => void) | undefined
let cacheEventUnsub: (() => void) | undefined
if (typeof window !== 'undefined' && window.api?.gh?.onWorkItemMutated) {
  workItemMutatedUnsub = window.api.gh.onWorkItemMutated(invalidateWorkItemDetailsCacheByMatch)
  cacheEventUnsub = onGitHubWorkItemDetailsCacheMutation(invalidateWorkItemDetailsCacheByMatch)
}
if (typeof import.meta !== 'undefined' && import.meta.hot) {
  import.meta.hot.dispose(() => {
    workItemMutatedUnsub?.()
    cacheEventUnsub?.()
  })
}
