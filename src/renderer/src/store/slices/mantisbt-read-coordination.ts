import type { AppState } from '../types'
import type { CacheEntry } from '../github/cache-model'
import type { MantisBTSlice, MantisBTSliceSet } from './mantisbt-slice-contract'
import type {
  MantisBTConnectionStatus,
  MantisBTIssue,
  MantisBTProject,
  MantisBTSiteSelection
} from '../../../../shared/mantisbt-types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500

export type InflightMantisBTReadRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
}

export type MantisBTReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

export const inflightMantisBTIssueRequests = new Map<
  string,
  InflightMantisBTReadRequest<MantisBTIssue | null>
>()
export const inflightMantisBTListRequests = new Map<
  string,
  InflightMantisBTReadRequest<MantisBTIssue[]>
>()
export const inflightMantisBTProjectRequests = new Map<
  string,
  InflightMantisBTReadRequest<MantisBTProject[]>
>()

export const EMPTY_MANTISBT_READ_CACHES = {
  mantisBTIssueCache: {},
  mantisBTSearchCache: {}
} satisfies Partial<MantisBTSlice>

export function isFreshMantisBTCacheEntry<T>(
  entry: CacheEntry<T> | undefined
): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

export function evictStaleMantisBTCacheEntries<T>(
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

export function looksLikeMantisBTAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /authenticat|unauthorized|401/i.test(message)
}

export function clearMantisBTInflightRequests(): void {
  inflightMantisBTIssueRequests.clear()
  inflightMantisBTListRequests.clear()
}

let mantisBTStatusReadGeneration = 0
let mantisBTMutationGeneration = 0

export function getSelectedMantisBTSiteId(
  status: MantisBTConnectionStatus
): MantisBTSiteSelection | null {
  return status.selectedSiteId ?? status.activeSiteId ?? null
}

export function beginMantisBTMutation(): number {
  mantisBTMutationGeneration += 1
  return mantisBTMutationGeneration
}

export function currentMantisBTMutationGeneration(): number {
  return mantisBTMutationGeneration
}

export function nextMantisBTStatusReadGeneration(): number {
  mantisBTStatusReadGeneration += 1
  return mantisBTStatusReadGeneration
}

export function isCurrentMantisBTStatusRead(generation: number): boolean {
  return generation === mantisBTStatusReadGeneration
}

export function isCurrentMantisBTMutation(generation: number): boolean {
  return generation === mantisBTMutationGeneration
}

export function isCurrentMantisBTRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

export function canWriteMantisBTReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    mutationGeneration === mantisBTMutationGeneration &&
    (explicitSource || isCurrentMantisBTRuntimeContext(contextKey, settings))
  )
}

export function getMantisBTReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): MantisBTReadScope {
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

export function scopedMantisBTCacheKey(scope: MantisBTReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

export function shouldRefreshMantisBTStatusAfterRead(
  siteId: MantisBTSiteSelection | null | undefined,
  status: MantisBTConnectionStatus,
  options?: { abortable?: boolean }
): boolean {
  if (status.credentialError !== undefined) {
    return true
  }
  // All-site reads can hide per-site failures; typeahead must not recheck on every keystroke.
  return siteId === 'all' && options?.abortable !== true
}

function nextMantisBTConnectionRevisions(
  revisions: Record<string, number>,
  contextKey: string
): Record<string, number> {
  return { ...revisions, [contextKey]: (revisions[contextKey] ?? 0) + 1 }
}

function mantisBTConnectionRevisionContextKey(
  settings: AppState['settings'] | TaskSourceContext | null
): string {
  return getProviderRuntimeContextKey(
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

export function markMantisBTConnectionLost(set: MantisBTSliceSet, scope: MantisBTReadScope): void {
  const revisionContextKey = mantisBTConnectionRevisionContextKey(scope.settings)
  set((state) => ({
    ...(scope.explicitSource
      ? {}
      : { mantisBTStatus: { ...state.mantisBTStatus, connected: false } }),
    mantisBTConnectionRevisions: nextMantisBTConnectionRevisions(
      state.mantisBTConnectionRevisions,
      revisionContextKey
    )
  }))
}

export function mantisBTStatusUpdate(
  state: AppState,
  contextKey: string,
  status: MantisBTConnectionStatus,
  extra?: Partial<MantisBTSlice>
): Partial<MantisBTSlice> {
  return {
    mantisBTStatus: status,
    mantisBTStatusChecked: true,
    mantisBTStatusContextKey: contextKey,
    mantisBTConnectionRevisions: nextMantisBTConnectionRevisions(
      state.mantisBTConnectionRevisions,
      contextKey
    ),
    ...extra
  }
}
