import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { ShortcutStory, ShortcutStoryFilter } from '../../../../../shared/shortcut-types'
import type { CacheEntry } from '../github'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { shortcutGetStory } from '@/runtime/runtime-shortcut-client'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import {
  canWriteShortcutReadResult,
  currentShortcutMutationGeneration,
  evictStaleEntries,
  getShortcutReadScope,
  inflightStoryRequests,
  isFresh,
  looksLikeAuthError,
  markShortcutConnectionLost,
  scopedShortcutCacheKey,
  shouldRefreshStatusAfterRead,
  type InflightShortcutReadRequest,
  type ShortcutPatchOptions,
  type ShortcutReadOptions,
  type ShortcutSearchOptions
} from './shortcut-read-scope'
import { createListShortcutStories, createSearchShortcutStories } from './shortcut-story-list-reads'

export type ShortcutStoryReadSlice = {
  shortcutStoryCache: Record<string, CacheEntry<ShortcutStory | null>>
  shortcutSearchCache: Record<string, CacheEntry<ShortcutStory[]>>

  fetchShortcutStory: (
    storyId: string,
    workspaceId?: string | null,
    options?: ShortcutReadOptions
  ) => Promise<ShortcutStory | null>
  searchShortcutStories: (
    query: string,
    limit?: number,
    options?: ShortcutSearchOptions
  ) => Promise<ShortcutStory[]>
  listShortcutStories: (
    filter?: ShortcutStoryFilter,
    limit?: number,
    options?: ShortcutReadOptions
  ) => Promise<ShortcutStory[]>
  patchShortcutStory: (
    storyId: string,
    patch: Partial<ShortcutStory>,
    options?: ShortcutPatchOptions
  ) => void
}

export const createShortcutStoryReadSlice: StateCreator<
  AppState,
  [],
  [],
  ShortcutStoryReadSlice
> = (set, get) => ({
  shortcutStoryCache: {},
  shortcutSearchCache: {},

  fetchShortcutStory: async (storyId, workspaceId, options) => {
    const scope = getShortcutReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const cacheKey = scopedShortcutCacheKey(scope, `${workspaceId ?? 'selected'}::${storyId}`)
    const cached = get().shortcutStoryCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data
    }
    const inflight = inflightStoryRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === currentShortcutMutationGeneration()
    ) {
      return inflight.promise
    }
    let entry: InflightShortcutReadRequest<ShortcutStory | null>
    const requestMutationGeneration = currentShortcutMutationGeneration()
    const canWrite = (): boolean =>
      canWriteShortcutReadResult(
        contextKey,
        requestMutationGeneration,
        get().settings,
        scope.explicitSource
      )
    const promise = shortcutGetStory(scope.settings, storyId, workspaceId)
      .then((story) => {
        if (inflightStoryRequests.get(cacheKey) === entry && canWrite()) {
          set((s) => ({
            shortcutStoryCache: evictStaleEntries({
              ...s.shortcutStoryCache,
              [cacheKey]: { data: story, fetchedAt: Date.now() }
            })
          }))
        }
        return story
      })
      .catch((error) => {
        console.warn('[shortcut] fetchShortcutStory failed:', error)
        if (isIntegrationCredentialDecryptionError(error) && canWrite()) {
          if (!shouldRefreshStatusAfterRead(workspaceId, get().shortcutStatus)) {
            void get().checkShortcutConnection()
          }
        } else if (looksLikeAuthError(error) && canWrite()) {
          markShortcutConnectionLost(set, scope)
        }
        return null
      })
      .finally(() => {
        if (inflightStoryRequests.get(cacheKey) === entry) {
          inflightStoryRequests.delete(cacheKey)
        }
        if (shouldRefreshStatusAfterRead(workspaceId, get().shortcutStatus) && canWrite()) {
          void get().checkShortcutConnection()
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightStoryRequests.set(cacheKey, entry)
    return promise
  },

  searchShortcutStories: createSearchShortcutStories(set, get),

  listShortcutStories: createListShortcutStories(set, get),

  patchShortcutStory: (storyId, patch, options) => {
    const sourceScope =
      options?.sourceContext?.provider === 'shortcut'
        ? getTaskSourceCacheScope(options.sourceContext)
        : null
    const canPatchCacheKey = (key: string): boolean =>
      sourceScope === null || key.startsWith(`${sourceScope}::`)
    set((s) => {
      let changed = false
      const nextStoryCache = { ...s.shortcutStoryCache }
      for (const [key, entry] of Object.entries(nextStoryCache)) {
        const data = entry?.data
        if (!canPatchCacheKey(key) || !data || data.id !== storyId) {
          continue
        }
        nextStoryCache[key] = { ...entry, data: { ...data, ...patch }, fetchedAt: 0 }
        changed = true
      }
      const nextSearchCache = { ...s.shortcutSearchCache }
      for (const key of Object.keys(nextSearchCache)) {
        const entry = nextSearchCache[key]
        if (!canPatchCacheKey(key) || !entry?.data) {
          continue
        }
        const index = entry.data.findIndex((story) => story.id === storyId)
        if (index === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[index] = { ...updatedItems[index], ...patch }
        nextSearchCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed
        ? { shortcutStoryCache: nextStoryCache, shortcutSearchCache: nextSearchCache }
        : {}
    })
  }
})
