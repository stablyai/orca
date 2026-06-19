import type { AppState } from '../types'
import type { GlpiServerSelection } from '../../../../shared/types'
import type { CacheEntry } from './github'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  evictStaleEntries,
  isFresh,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead,
  type GlpiReadScope
} from './glpi-cache-keys'

type StoreApi = {
  get: () => AppState
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void
}

type Inflight<T> = { promise: Promise<T>; contextKey: string; mutationGeneration: number }

// Generic cached read with inflight dedup, stale-response guards, credential
// surfacing, and status refresh — shared by ticket/list/followup reads so each
// action stays a thin descriptor instead of duplicating the lifecycle.
export type GlpiReadConfig<T> = {
  store: StoreApi
  scope: GlpiReadScope
  cacheKey: string
  cacheField: 'glpiTicketCache' | 'glpiListCache' | 'glpiFollowupsCache'
  inflight: Map<string, Inflight<T>>
  serverId: GlpiServerSelection | string | null | undefined
  mutationGeneration: number
  isCurrentMutation: (generation: number) => boolean
  fallback: T
  fetch: () => Promise<T>
  operation: string
}

function canWrite<T>(config: GlpiReadConfig<T>): boolean {
  return (
    config.isCurrentMutation(config.mutationGeneration) &&
    (config.scope.explicitSource ||
      getProviderRuntimeContextKey(config.store.get().settings) === config.scope.contextKey)
  )
}

function refreshStatus<T>(config: GlpiReadConfig<T>): void {
  if (
    shouldRefreshStatusAfterRead(config.serverId, config.store.get().glpiStatus) &&
    canWrite(config)
  ) {
    void config.store.get().checkGlpiConnection()
  }
}

function handleReadError<T>(config: GlpiReadConfig<T>, error: unknown): void {
  console.warn(`[glpi] ${config.operation} failed:`, error)
  if (isIntegrationCredentialDecryptionError(error) && canWrite(config)) {
    if (!shouldRefreshStatusAfterRead(config.serverId, config.store.get().glpiStatus)) {
      void config.store.get().checkGlpiConnection()
    }
  } else if (looksLikeAuthError(error) && canWrite(config)) {
    config.store.set({ glpiStatus: { connected: false, viewer: null } })
  }
}

export function runGlpiCachedRead<T>(config: GlpiReadConfig<T>): Promise<T> {
  const { store, cacheKey, inflight, scope, mutationGeneration } = config
  const cached = store.get()[config.cacheField][cacheKey] as CacheEntry<T> | undefined
  if (isFresh(cached)) {
    return Promise.resolve(cached.data ?? config.fallback)
  }
  const existing = inflight.get(cacheKey)
  if (
    existing &&
    existing.contextKey === scope.contextKey &&
    config.isCurrentMutation(existing.mutationGeneration)
  ) {
    return existing.promise
  }
  let entry: Inflight<T>
  const promise = config
    .fetch()
    .then((data) => {
      if (inflight.get(cacheKey) === entry && canWrite(config)) {
        store.set((s) => ({
          [config.cacheField]: evictStaleEntries({
            ...(s[config.cacheField] as Record<string, CacheEntry<T>>),
            [cacheKey]: { data, fetchedAt: Date.now() }
          })
        }))
      }
      return data
    })
    .catch((error) => {
      handleReadError(config, error)
      return config.fallback
    })
    .finally(() => {
      if (inflight.get(cacheKey) === entry) {
        inflight.delete(cacheKey)
      }
      refreshStatus(config)
    })
  entry = { promise, contextKey: scope.contextKey, mutationGeneration }
  inflight.set(cacheKey, entry)
  return promise
}
