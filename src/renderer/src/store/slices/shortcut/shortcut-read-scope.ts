import type { AppState } from '../../types'
import type {
  ShortcutConnectionStatus,
  ShortcutStory,
  ShortcutWorkspaceSelection
} from '../../../../../shared/shortcut-types'
import type { CacheEntry } from '../github'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500

export function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

export function evictStaleEntries<T>(
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

export function looksLikeAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  // Why: Shortcut 403 commonly means entitlement/permission gaps while the
  // saved token is still valid; do not flip Settings back to disconnected.
  // 401 is boundary-anchored so ids inside messages (e.g. "Story 1401") don't match.
  return /authenticat|unauthorized|\b401\b/i.test(msg)
}

export type InflightShortcutReadRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
}

export function createShortcutAbortError(what: string): Error {
  const error = new Error(`Shortcut ${what} aborted`)
  error.name = 'AbortError'
  return error
}

export type ShortcutReadOptions = {
  sourceContext?: TaskSourceContext | null
  workspaceId?: ShortcutWorkspaceSelection | null
}
export type ShortcutSearchOptions = ShortcutReadOptions & { signal?: AbortSignal }
export type ShortcutPatchOptions = { sourceContext?: TaskSourceContext | null }

export type ShortcutReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

export const inflightStoryRequests = new Map<
  string,
  InflightShortcutReadRequest<ShortcutStory | null>
>()
export const inflightSearchRequests = new Map<
  string,
  InflightShortcutReadRequest<ShortcutStory[]>
>()
export const inflightListRequests = new Map<string, InflightShortcutReadRequest<ShortcutStory[]>>()

let shortcutStatusReadGeneration = 0
let shortcutMutationGeneration = 0

export function nextShortcutStatusReadGeneration(): number {
  shortcutStatusReadGeneration += 1
  return shortcutStatusReadGeneration
}

export function currentShortcutStatusReadGeneration(): number {
  return shortcutStatusReadGeneration
}

export function beginShortcutMutation(): number {
  shortcutMutationGeneration += 1
  return shortcutMutationGeneration
}

export function currentShortcutMutationGeneration(): number {
  return shortcutMutationGeneration
}

export function isCurrentShortcutMutation(generation: number): boolean {
  return generation === shortcutMutationGeneration
}

export function getSelectedWorkspaceId(
  status: ShortcutConnectionStatus
): ShortcutWorkspaceSelection | null {
  return status.selectedWorkspaceId ?? status.activeWorkspaceId ?? null
}

export function shouldRefreshStatusAfterRead(
  workspaceId: ShortcutWorkspaceSelection | null | undefined,
  status: ShortcutConnectionStatus,
  options?: { abortable?: boolean }
): boolean {
  // Why: a visible credential error may have been cleared by a successful credential read.
  if (status.credentialError !== undefined) {
    return true
  }
  // Why: 'all' reads can hide per-workspace decrypt failures. Abortable typeahead
  // (composer search) must not re-check status on every keystroke.
  return workspaceId === 'all' && options?.abortable !== true
}

export function clearShortcutInflight(): void {
  inflightStoryRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

export function isCurrentShortcutRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

export function canWriteShortcutReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    mutationGeneration === shortcutMutationGeneration &&
    (explicitSource || isCurrentShortcutRuntimeContext(contextKey, settings))
  )
}

export function getShortcutReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): ShortcutReadScope {
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

export function scopedShortcutCacheKey(scope: ShortcutReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

export function getShortcutConnectionRevisionContextKey(
  settings: AppState['settings'] | TaskSourceContext | null
): string {
  return getProviderRuntimeContextKey(
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

export function nextShortcutConnectionRevisions(
  revisions: Record<string, number>,
  contextKey: string
): Record<string, number> {
  return { ...revisions, [contextKey]: (revisions[contextKey] ?? 0) + 1 }
}

/**
 * An auth failure on a read invalidates the connection: bump the revision so lazy readers re-probe.
 * An explicit source context owns its own status, so only the ambient status is reset.
 */
export function markShortcutConnectionLost(
  set: (partial: (state: AppState) => Partial<AppState>) => void,
  scope: ShortcutReadScope
): void {
  const revisionContextKey = getShortcutConnectionRevisionContextKey(scope.settings)
  set((state) => ({
    ...(scope.explicitSource ? {} : { shortcutStatus: { connected: false, viewer: null } }),
    shortcutConnectionRevisions: nextShortcutConnectionRevisions(
      state.shortcutConnectionRevisions,
      revisionContextKey
    )
  }))
}
