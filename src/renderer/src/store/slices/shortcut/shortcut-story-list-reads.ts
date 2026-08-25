import type { AppState } from '../../types'
import type { ShortcutStory, ShortcutStoryFilter } from '../../../../../shared/shortcut-types'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { shortcutListStories, shortcutSearchStories } from '@/runtime/runtime-shortcut-client'
import {
  canWriteShortcutReadResult,
  createShortcutAbortError,
  currentShortcutMutationGeneration,
  evictStaleEntries,
  getSelectedWorkspaceId,
  getShortcutReadScope,
  inflightListRequests,
  inflightSearchRequests,
  isFresh,
  looksLikeAuthError,
  markShortcutConnectionLost,
  scopedShortcutCacheKey,
  shouldRefreshStatusAfterRead,
  type InflightShortcutReadRequest,
  type ShortcutReadOptions,
  type ShortcutSearchOptions
} from './shortcut-read-scope'

type SliceSet = (partial: (state: AppState) => Partial<AppState>) => void
type SliceGet = () => AppState

export function createSearchShortcutStories(set: SliceSet, get: SliceGet) {
  return async (
    query: string,
    limit = 30,
    options?: ShortcutSearchOptions
  ): Promise<ShortcutStory[]> => {
    const scope = getShortcutReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const workspaceId =
      options && 'workspaceId' in options
        ? options.workspaceId
        : getSelectedWorkspaceId(get().shortcutStatus)
    const cacheKey = scopedShortcutCacheKey(
      scope,
      `${workspaceId ?? 'default'}::${query}::${limit}`
    )
    const cached = get().shortcutSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightSearchRequests.get(cacheKey)
    // Why: an abortable search must not be shared — one caller's cleanup would cancel the other's.
    if (
      !options?.signal &&
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === currentShortcutMutationGeneration()
    ) {
      return inflight.promise
    }
    let entry: InflightShortcutReadRequest<ShortcutStory[]>
    const abortable = options?.signal !== undefined
    const requestMutationGeneration = currentShortcutMutationGeneration()
    const canWrite = (): boolean =>
      canWriteShortcutReadResult(
        contextKey,
        requestMutationGeneration,
        get().settings,
        scope.explicitSource
      )
    const promise = shortcutSearchStories(
      scope.settings,
      query,
      limit,
      workspaceId,
      options?.signal
    )
      .then((stories) => {
        if (options?.signal?.aborted) {
          // Late success after cancel must not warm the cache for a superseded query.
          throw createShortcutAbortError('search')
        }
        if ((abortable || inflightSearchRequests.get(cacheKey) === entry) && canWrite()) {
          set((s) => ({
            shortcutSearchCache: evictStaleEntries({
              ...s.shortcutSearchCache,
              [cacheKey]: { data: stories, fetchedAt: Date.now() }
            })
          }))
        }
        return stories
      })
      .catch((error) => {
        if (options?.signal?.aborted) {
          // Superseded by a newer query: not a connection problem, so leave status untouched.
          throw error
        }
        console.warn('[shortcut] searchShortcutStories failed:', error)
        if (isIntegrationCredentialDecryptionError(error) && canWrite()) {
          if (!shouldRefreshStatusAfterRead(workspaceId, get().shortcutStatus, { abortable })) {
            void get().checkShortcutConnection()
          }
        } else if (looksLikeAuthError(error) && canWrite()) {
          markShortcutConnectionLost(set, scope)
        }
        // Credential/auth failures are surfaced through connection state, so they
        // keep the empty-list contract. Other failures (forbidden, bad query,
        // network, 5xx) reject so the Tasks panel can show a real error instead
        // of a misleading "No stories found".
        if (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) {
          return []
        }
        throw error
      })
      .finally(() => {
        if (inflightSearchRequests.get(cacheKey) === entry) {
          inflightSearchRequests.delete(cacheKey)
        }
        if (
          !options?.signal?.aborted &&
          shouldRefreshStatusAfterRead(workspaceId, get().shortcutStatus, { abortable }) &&
          canWrite()
        ) {
          void get().checkShortcutConnection()
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    if (!abortable) {
      inflightSearchRequests.set(cacheKey, entry)
    }
    return promise
  }
}

export function createListShortcutStories(set: SliceSet, get: SliceGet) {
  return async (
    filter: ShortcutStoryFilter = 'assigned',
    limit = 30,
    options?: ShortcutReadOptions
  ): Promise<ShortcutStory[]> => {
    const scope = getShortcutReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const workspaceId = getSelectedWorkspaceId(get().shortcutStatus)
    const cacheKey = scopedShortcutCacheKey(
      scope,
      `${workspaceId ?? 'default'}::list::${filter}::${limit}`
    )
    const cached = get().shortcutSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === currentShortcutMutationGeneration()
    ) {
      return inflight.promise
    }
    let entry: InflightShortcutReadRequest<ShortcutStory[]>
    const requestMutationGeneration = currentShortcutMutationGeneration()
    const canWrite = (): boolean =>
      canWriteShortcutReadResult(
        contextKey,
        requestMutationGeneration,
        get().settings,
        scope.explicitSource
      )
    const promise = shortcutListStories(scope.settings, filter, limit, workspaceId)
      .then((stories) => {
        if (inflightListRequests.get(cacheKey) === entry && canWrite()) {
          set((s) => ({
            shortcutSearchCache: evictStaleEntries({
              ...s.shortcutSearchCache,
              [cacheKey]: { data: stories, fetchedAt: Date.now() }
            })
          }))
        }
        return stories
      })
      .catch((error) => {
        console.warn('[shortcut] listShortcutStories failed:', error)
        if (isIntegrationCredentialDecryptionError(error) && canWrite()) {
          if (!shouldRefreshStatusAfterRead(workspaceId, get().shortcutStatus)) {
            void get().checkShortcutConnection()
          }
        } else if (looksLikeAuthError(error) && canWrite()) {
          markShortcutConnectionLost(set, scope)
        }
        if (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) {
          return []
        }
        throw error
      })
      .finally(() => {
        if (inflightListRequests.get(cacheKey) === entry) {
          inflightListRequests.delete(cacheKey)
        }
        if (shouldRefreshStatusAfterRead(workspaceId, get().shortcutStatus) && canWrite()) {
          void get().checkShortcutConnection()
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightListRequests.set(cacheKey, entry)
    return promise
  }
}
