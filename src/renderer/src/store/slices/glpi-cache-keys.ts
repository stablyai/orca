import type { AppState } from '../types'
import type { GlpiConnectionStatus, GlpiServerSelection } from '../../../../shared/types'
import type { CacheEntry } from './github'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'

export const CACHE_TTL = 60_000
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
  return /authenticat|unauthorized|forbidden|401|403/i.test(msg)
}

export function getSelectedServerId(status: GlpiConnectionStatus): GlpiServerSelection | null {
  return status.selectedServerId ?? status.activeServerId ?? null
}

export function shouldRefreshStatusAfterRead(
  serverId: GlpiServerSelection | null | undefined,
  status: GlpiConnectionStatus
): boolean {
  // Why: 'all' reads can hide per-server decrypt failures, and a visible
  // credential error may have been cleared by a successful credential read.
  return serverId === 'all' || status.credentialError !== undefined
}

export type GlpiReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

export function getGlpiReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): GlpiReadScope {
  if (!sourceContext) {
    // Why: namespace default-scope keys by runtime context so cached data can't
    // bleed across runtime environments, mirroring the source-scoped path.
    const runtimeContextKey = getProviderRuntimeContextKey(settings)
    return {
      settings,
      contextKey: runtimeContextKey,
      cachePrefix: runtimeContextKey,
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

export function scopedGlpiCacheKey(scope: GlpiReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

type GlpiStore = { get: () => AppState; set: (partial: Partial<AppState>) => void }

// Why: a successful mutation invalidates only the scope it touched so a later
// read refetches fresh data while unrelated scopes keep their cache warm.
export function invalidateGlpiTicket(
  id: number,
  serverId: string | null | undefined,
  sourceContext: TaskSourceContext | null | undefined,
  store: GlpiStore
): void {
  const scope = getGlpiReadScope(store.get().settings, sourceContext)
  store.set({
    glpiTicketCache: dropKey(
      store.get().glpiTicketCache,
      scope,
      `${serverId ?? 'selected'}::${id}`
    ),
    glpiFollowupsCache: dropKey(
      store.get().glpiFollowupsCache,
      scope,
      `${serverId ?? 'selected'}::followups::${id}`
    ),
    glpiListCache: dropScopePrefix(store.get().glpiListCache, scope)
  })
}

export function invalidateGlpiList(
  sourceContext: TaskSourceContext | null | undefined,
  store: GlpiStore
): void {
  const scope = getGlpiReadScope(store.get().settings, sourceContext)
  store.set({ glpiListCache: dropScopePrefix(store.get().glpiListCache, scope) })
}

function dropKey<T>(
  cache: Record<string, CacheEntry<T>>,
  scope: GlpiReadScope,
  suffix: string
): Record<string, CacheEntry<T>> {
  const target = scopedGlpiCacheKey(scope, suffix)
  if (cache[target] === undefined) {
    return cache
  }
  const next = { ...cache }
  delete next[target]
  return next
}

function dropScopePrefix<T>(
  cache: Record<string, CacheEntry<T>>,
  scope: GlpiReadScope
): Record<string, CacheEntry<T>> {
  const prefix = scope.cachePrefix ? `${scope.cachePrefix}::` : null
  const next: Record<string, CacheEntry<T>> = {}
  let changed = false
  for (const [key, value] of Object.entries(cache)) {
    if (prefix === null || key.startsWith(prefix)) {
      changed = true
      continue
    }
    next[key] = value
  }
  return changed ? next : cache
}
