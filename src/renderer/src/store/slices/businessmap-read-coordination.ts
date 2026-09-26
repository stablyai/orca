import type { AppState } from '../types'
import type { CacheEntry } from '../github/cache-model'
import type { BusinessmapSlice, BusinessmapSliceSet } from './businessmap-slice-contract'
import type {
  BusinessmapCard,
  BusinessmapConnectionStatus
} from '../../../../shared/businessmap-types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500

export type InflightBusinessmapReadRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
  readInvalidationGeneration: number
}

export type BusinessmapReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

export const inflightBusinessmapCardRequests = new Map<
  string,
  InflightBusinessmapReadRequest<BusinessmapCard | null>
>()
export const inflightBusinessmapSearchRequests = new Map<
  string,
  InflightBusinessmapReadRequest<BusinessmapCard[]>
>()
export const inflightBusinessmapListRequests = new Map<
  string,
  InflightBusinessmapReadRequest<BusinessmapCard[]>
>()
export const inflightBusinessmapBoardRequests = new Map<
  string,
  InflightBusinessmapReadRequest<unknown>
>()
// Why: abortable searches skip inflight dedupe, so a per-key sequence fences out-of-order writes.
const businessmapSearchRequestSequences = new Map<string, number>()

let businessmapStatusReadGeneration = 0
let businessmapMutationGeneration = 0
let businessmapReadInvalidationGeneration = 0

export const EMPTY_BUSINESSMAP_READ_CACHES = {
  businessmapCardCache: {},
  businessmapBoardCache: {},
  businessmapSearchCache: {}
} satisfies Partial<BusinessmapSlice>

export function isFreshBusinessmapCacheEntry<T>(
  entry: CacheEntry<T> | undefined
): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

export function evictStaleBusinessmapCacheEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const key of sorted.slice(sorted.length - maxEntries)) {
    pruned[key] = cache[key]
  }
  return pruned
}

export function looksLikeBusinessmapAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /authenticat|unauthorized|401/i.test(message)
}

export function createBusinessmapAbortError(what: string): Error {
  const error = new Error(`Businessmap ${what} aborted`)
  error.name = 'AbortError'
  return error
}

export function getSelectedBusinessmapSiteId(status: BusinessmapConnectionStatus): string | null {
  return status.selectedSiteId ?? status.activeSiteId ?? null
}

export function clearBusinessmapInflightRequests(): void {
  inflightBusinessmapCardRequests.clear()
  inflightBusinessmapSearchRequests.clear()
  inflightBusinessmapListRequests.clear()
  inflightBusinessmapBoardRequests.clear()
  businessmapSearchRequestSequences.clear()
}
export function beginBusinessmapMutation(): number {
  businessmapMutationGeneration += 1
  return businessmapMutationGeneration
}
// Why: status probes observe the generation without invalidating in-flight connection work.
export function peekBusinessmapMutationGeneration(): number {
  return businessmapMutationGeneration
}
// Why: reads started before a card write must not repopulate cleared caches.
export function invalidateBusinessmapReads(): number {
  businessmapReadInvalidationGeneration += 1
  return businessmapReadInvalidationGeneration
}
export function currentBusinessmapReadInvalidationGeneration(): number {
  return businessmapReadInvalidationGeneration
}
// Why: abortable searches share a cache key without inflight dedupe; last write wins.
export function nextBusinessmapSearchRequestSequence(cacheKey: string): number {
  const next = (businessmapSearchRequestSequences.get(cacheKey) ?? 0) + 1
  businessmapSearchRequestSequences.set(cacheKey, next)
  return next
}
export function currentBusinessmapSearchRequestSequence(cacheKey: string): number {
  return businessmapSearchRequestSequences.get(cacheKey) ?? 0
}

export function nextBusinessmapStatusReadGeneration(): number {
  businessmapStatusReadGeneration += 1
  return businessmapStatusReadGeneration
}

export function isCurrentBusinessmapStatusRead(generation: number): boolean {
  return generation === businessmapStatusReadGeneration
}

export function isCurrentBusinessmapMutation(generation: number): boolean {
  return generation === businessmapMutationGeneration
}

export function isCurrentBusinessmapRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

export function canWriteBusinessmapReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false,
  readInvalidationGeneration?: number
): boolean {
  return (
    mutationGeneration === businessmapMutationGeneration &&
    (readInvalidationGeneration === undefined ||
      readInvalidationGeneration === businessmapReadInvalidationGeneration) &&
    (explicitSource || isCurrentBusinessmapRuntimeContext(contextKey, settings))
  )
}

export function getBusinessmapReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): BusinessmapReadScope {
  if (!sourceContext) {
    return {
      settings,
      contextKey: getProviderRuntimeContextKey(settings),
      cachePrefix: null,
      explicitSource: false
    }
  }
  const runtimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  return {
    settings: sourceContext,
    contextKey: `${getProviderRuntimeContextKey(runtimeSettings)}::${getTaskSourceCacheScope(sourceContext)}`,
    cachePrefix: getTaskSourceCacheScope(sourceContext),
    explicitSource: true
  }
}

export function scopedBusinessmapCacheKey(scope: BusinessmapReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

function businessmapConnectionRevisionContextKey(
  settings: AppState['settings'] | TaskSourceContext | null
): string {
  return getProviderRuntimeContextKey(
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

function nextBusinessmapConnectionRevisions(
  revisions: Record<string, number>,
  contextKey: string
): Record<string, number> {
  return { ...revisions, [contextKey]: (revisions[contextKey] ?? 0) + 1 }
}

export function markBusinessmapConnectionLost(
  set: BusinessmapSliceSet,
  scope: BusinessmapReadScope
): void {
  const revisionContextKey = businessmapConnectionRevisionContextKey(scope.settings)
  set((state) => ({
    ...(scope.explicitSource ? {} : { businessmapStatus: { connected: false, viewer: null } }),
    businessmapConnectionRevisions: nextBusinessmapConnectionRevisions(
      state.businessmapConnectionRevisions,
      revisionContextKey
    )
  }))
}

export function businessmapStatusUpdate(
  state: AppState,
  contextKey: string,
  status: BusinessmapConnectionStatus,
  extra?: Partial<BusinessmapSlice>
): Partial<BusinessmapSlice> {
  return {
    businessmapStatus: status,
    businessmapStatusChecked: true,
    businessmapStatusContextKey: contextKey,
    businessmapConnectionRevisions: nextBusinessmapConnectionRevisions(
      state.businessmapConnectionRevisions,
      contextKey
    ),
    ...extra
  }
}
