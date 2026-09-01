// Read-path machinery for the Odoo slice: scoped cache keys, in-flight
// deduplication, and mutation/context generations. Jira inlines this pattern
// per method; Odoo centralizes it so each slice read stays a thin wrapper.
import type { AppState } from '../types'
import type { OdooConnectionStatus, OdooInstanceSelection } from '../../../../shared/odoo-types'
import type { CacheEntry } from '../github/cache-model'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'

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

/** Single classifier for "the stored credential failed", shared with the list-read fallback. */
export function looksLikeOdooAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  // Why: Odoo raises AccessError for record-permission gaps while the API key
  // stays valid; only credential rejection should flip Settings to
  // disconnected. The client maps that to AccessDenied wording, and an
  // undecryptable stored key is the same class of failure.
  return /AccessDenied|rejected the credentials|authenticat|unauthorized|401|decrypt/i.test(msg)
}

export type InflightOdooRead<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
}

export type OdooReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

let odooStatusReadGeneration = 0
let odooMutationGeneration = 0

export function beginOdooStatusRead(): number {
  odooStatusReadGeneration += 1
  return odooStatusReadGeneration
}

export function isCurrentOdooStatusRead(generation: number): boolean {
  return generation === odooStatusReadGeneration
}

export function beginOdooMutation(): number {
  odooMutationGeneration += 1
  return odooMutationGeneration
}

export function currentOdooMutationGeneration(): number {
  return odooMutationGeneration
}

export function isCurrentOdooMutation(generation: number): boolean {
  return generation === odooMutationGeneration
}

export function isCurrentOdooRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

export function canWriteOdooReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    mutationGeneration === odooMutationGeneration &&
    (explicitSource || isCurrentOdooRuntimeContext(contextKey, settings))
  )
}

export function getOdooReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): OdooReadScope {
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

export function scopedOdooCacheKey(scope: OdooReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

export type ExecuteOdooReadArgs<T> = {
  inflight: Map<string, InflightOdooRead<T>>
  cacheKey: string
  scope: OdooReadScope
  getState: () => AppState
  fetch: () => Promise<T>
  /** Called only when the runtime context and mutation generation still match. */
  writeCache: (value: T) => void
  onAuthLost: () => void
  refreshStatus: () => void
  /** True when connection state may hide per-instance credential errors. */
  shouldRefreshAfterRead: boolean
  /** Maps a failed read to a fallback value; rethrow to surface the error. */
  fallback: (error: unknown) => T
}

/**
 * Runs one deduplicated Odoo read. Cache freshness is the caller's job.
 *
 * Encodes the invariants the Jira slice repeats inline: a stale runtime
 * context or superseded mutation generation must never write results, and
 * credential errors surface through connection state instead of data.
 */
export function executeOdooRead<T>(args: ExecuteOdooReadArgs<T>): Promise<T> {
  const inflight = args.inflight.get(args.cacheKey)
  if (
    inflight &&
    inflight.contextKey === args.scope.contextKey &&
    inflight.mutationGeneration === odooMutationGeneration
  ) {
    return inflight.promise
  }

  let entry: InflightOdooRead<T>
  const requestMutationGeneration = odooMutationGeneration
  const canWrite = (): boolean =>
    canWriteOdooReadResult(
      args.scope.contextKey,
      requestMutationGeneration,
      args.getState().settings,
      args.scope.explicitSource
    )

  const promise = args
    .fetch()
    .then((fetched) => {
      // Awaited<T> and T coincide here: no Odoo read resolves to a promise.
      const value = fetched as T
      if (args.inflight.get(args.cacheKey) === entry && canWrite()) {
        args.writeCache(value)
      }
      return value
    })
    .catch((error) => {
      console.warn('[odoo] read failed:', error)
      if (isIntegrationCredentialDecryptionError(error) && canWrite()) {
        if (!args.shouldRefreshAfterRead) {
          args.refreshStatus()
        }
      } else if (looksLikeOdooAuthError(error) && canWrite()) {
        args.onAuthLost()
      }
      return args.fallback(error)
    })
    .finally(() => {
      if (args.inflight.get(args.cacheKey) === entry) {
        args.inflight.delete(args.cacheKey)
      }
      if (args.shouldRefreshAfterRead && canWrite()) {
        args.refreshStatus()
      }
    })
  entry = {
    promise,
    contextKey: args.scope.contextKey,
    mutationGeneration: requestMutationGeneration
  }
  args.inflight.set(args.cacheKey, entry)
  return promise
}

export function getSelectedOdooInstanceId(
  status: OdooConnectionStatus
): OdooInstanceSelection | null {
  return status.selectedInstanceId ?? status.activeInstanceId ?? null
}

export function shouldRefreshOdooStatusAfterRead(
  instanceId: OdooInstanceSelection | null | undefined,
  status: OdooConnectionStatus
): boolean {
  // Why: 'all' reads can hide per-instance decrypt failures, and a visible
  // credential error may have been cleared by a successful credential read.
  return instanceId === 'all' || status.credentialError !== undefined
}
