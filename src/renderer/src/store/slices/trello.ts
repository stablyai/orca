import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  trelloAddCardComment,
  trelloCardComments,
  trelloConnect,
  trelloDisconnect,
  trelloGetCard,
  trelloListCards,
  trelloSearchCards,
  trelloStatus,
  trelloTestConnection
} from '@/runtime/runtime-trello-client'
import {
  isFresh,
  evictStaleEntries,
  looksLikeAuthError,
  inflightCardRequests,
  inflightSearchRequests,
  inflightListRequests,
  clearTrelloInflight,
  createInitialTrelloState
} from './trello-cache-state'
import { applyPatchToTrelloCacheEntries } from './trello-card-cache-updates'
import { createTrelloReferenceDataActions } from './trello-reference-data-actions'
export type { TrelloSlice } from './trello-slice-contract'
import type { TrelloSlice } from './trello-slice-contract'
import { clearTrelloImageCache } from '@/lib/trello-authenticated-images'

export const createTrelloSlice: StateCreator<AppState, [], [], TrelloSlice> = (set, get) => ({
  ...createInitialTrelloState(),

  checkTrelloConnection: async () => {
    try {
      const status = await trelloStatus(get().settings)
      const prev = get().trelloStatus
      if (
        prev.connected !== status.connected ||
        prev.viewer?.username !== status.viewer?.username
      ) {
        set({ trelloStatus: status, trelloStatusChecked: true })
      } else if (!get().trelloStatusChecked) {
        set({ trelloStatusChecked: true })
      }
    } catch {
      if (get().trelloStatus.connected) {
        set({ trelloStatus: { connected: false, viewer: null }, trelloStatusChecked: true })
      } else if (!get().trelloStatusChecked) {
        set({ trelloStatusChecked: true })
      }
    }
  },

  connectTrello: async (args) => {
    try {
      const result = await trelloConnect(get().settings, args)
      if (result.ok) {
        set({ trelloStatus: { connected: true, viewer: result.viewer }, trelloStatusChecked: true })
        void get().checkTrelloConnection()
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  testTrelloConnection: async () => {
    try {
      const result = await trelloTestConnection(get().settings)
      const status = await trelloStatus(get().settings)
      set({ trelloStatus: status, trelloStatusChecked: true })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  disconnectTrello: async () => {
    await trelloDisconnect(get().settings)
    clearTrelloInflight()
    clearTrelloImageCache()
    const status = await trelloStatus(get().settings)
    set({
      ...createInitialTrelloState(),
      trelloCacheGeneration: get().trelloCacheGeneration + 1,
      trelloStatus: status.connected ? status : { connected: false, viewer: null },
      trelloStatusChecked: true
    })
  },
  fetchTrelloCard: async (cardId, options) => {
    const cached = get().trelloCardCache[cardId]
    if (!options?.force && isFresh(cached)) {
      return cached.data
    }
    if (!options?.force) {
      const inflight = inflightCardRequests.get(cardId)
      if (inflight) {
        return inflight
      }
    }
    const gen = get().trelloCacheGeneration
    const promise = trelloGetCard(get().settings, cardId)
      .then((card) => {
        if (get().trelloCacheGeneration !== gen) {
          return card
        }
        set((s) => ({
          trelloCardCache: evictStaleEntries({
            ...s.trelloCardCache,
            [cardId]: { data: card, fetchedAt: Date.now() }
          })
        }))
        return card
      })
      .catch((error) => {
        console.warn('[trello] fetchTrelloCard failed:', error)
        if (looksLikeAuthError(error)) {
          set({ trelloStatus: { connected: false, viewer: null } })
        }
        throw error
      })
      .finally(() => {
        inflightCardRequests.delete(cardId)
      })
    inflightCardRequests.set(cardId, promise)
    return promise
  },

  searchTrelloCards: async (query, limit = 30, boardIds, options) => {
    const cacheKey = `search::${query}::${limit}::${(boardIds ?? []).join(',')}`
    const cached = get().trelloSearchCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightSearchRequests.get(cacheKey)
    if (!options?.force && inflight) {
      return inflight
    }
    const gen = get().trelloCacheGeneration
    const promise = trelloSearchCards(get().settings, query, limit, boardIds)
      .then((cards) => {
        if (get().trelloCacheGeneration !== gen) {
          return cards
        }
        set((s) => ({
          trelloSearchCache: evictStaleEntries({
            ...s.trelloSearchCache,
            [cacheKey]: { data: cards, fetchedAt: Date.now() }
          })
        }))
        return cards
      })
      .catch((error) => {
        console.warn('[trello] searchTrelloCards failed:', error)
        if (looksLikeAuthError(error)) {
          set({ trelloStatus: { connected: false, viewer: null } })
        }
        throw error
      })
      .finally(() => {
        inflightSearchRequests.delete(cacheKey)
      })
    inflightSearchRequests.set(cacheKey, promise)
    return promise
  },

  listTrelloCards: async (filter = 'assigned', limit = 30, boardIds, options) => {
    const cacheKey = `list::${filter}::${limit}::${(boardIds ?? []).join(',')}`
    const cached = get().trelloSearchCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (!options?.force && inflight) {
      return inflight
    }
    const gen = get().trelloCacheGeneration
    const promise = trelloListCards(get().settings, filter, limit, boardIds)
      .then((cards) => {
        if (get().trelloCacheGeneration !== gen) {
          return cards
        }
        set((s) => ({
          trelloSearchCache: evictStaleEntries({
            ...s.trelloSearchCache,
            [cacheKey]: { data: cards, fetchedAt: Date.now() }
          })
        }))
        return cards
      })
      .catch((error) => {
        console.warn('[trello] listTrelloCards failed:', error)
        if (looksLikeAuthError(error)) {
          set({ trelloStatus: { connected: false, viewer: null } })
        }
        throw error
      })
      .finally(() => {
        inflightListRequests.delete(cacheKey)
      })
    inflightListRequests.set(cacheKey, promise)
    return promise
  },

  ...createTrelloReferenceDataActions(set, get),

  fetchTrelloComments: async (cardId, options) => {
    if (!options?.force) {
      const cached = get().trelloCommentsCache[cardId]
      if (isFresh(cached)) {
        return cached.data ?? []
      }
    }
    // When forced, skip cache and fetch fresh; also clear any inflight for
    // this card so a stale deduped promise doesn't shadow the new request.
    if (options?.force) {
      // Let a new request proceed even if one is in flight
    }
    const gen = get().trelloCacheGeneration
    const comments = await trelloCardComments(get().settings, cardId)
    if (get().trelloCacheGeneration === gen) {
      set((s) => ({
        trelloCommentsCache: {
          ...s.trelloCommentsCache,
          [cardId]: { data: comments, fetchedAt: Date.now() }
        }
      }))
    }
    return comments
  },

  addTrelloCardComment: async (cardId, text) => {
    const gen = get().trelloCacheGeneration
    try {
      const result = await trelloAddCardComment(get().settings, cardId, text)
      if (result.ok) {
        // Invalidate comments cache and force-refresh so the caller
        // doesn't read stale data on the next render.
        if (get().trelloCacheGeneration === gen) {
          set((s) => {
            const next = { ...s.trelloCommentsCache }
            delete next[cardId]
            return { trelloCommentsCache: next }
          })
          // Trigger an async forced refresh — fire-and-forget; errors
          // surface via the comments cache/error state.
          void get().fetchTrelloComments(cardId, { force: true })
        }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Comment failed'
      return { ok: false as const, error: message }
    }
  },

  patchTrelloCard: (cardId, patch) => {
    set((s) =>
      applyPatchToTrelloCacheEntries(cardId, patch, s.trelloCardCache, s.trelloSearchCache)
    )
  }
})
