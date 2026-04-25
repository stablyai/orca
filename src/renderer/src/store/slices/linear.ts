import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { LinearViewer, LinearConnectionStatus, LinearIssue } from '../../../../shared/types'
import type { CacheEntry } from './github'
import { clearLinearMetadataCache } from '../../hooks/useIssueMetadata'

const CACHE_TTL = 60_000 // 60s — same as GitHub work-items TTL
const MAX_CACHE_ENTRIES = 500

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

function evictStaleEntries<T>(
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

function looksLikeAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /authenticat|unauthorized|401/i.test(msg)
}

const inflightIssueRequests = new Map<string, Promise<LinearIssue | null>>()
const inflightSearchRequests = new Map<string, Promise<LinearIssue[]>>()
const inflightListRequests = new Map<string, Promise<LinearIssue[]>>()

export type LinearSlice = {
  linearStatus: LinearConnectionStatus
  linearStatusChecked: boolean
  linearIssueCache: Record<string, CacheEntry<LinearIssue>>
  linearSearchCache: Record<string, CacheEntry<LinearIssue[]>>

  checkLinearConnection: () => Promise<void>
  connectLinear: (
    apiKey: string
  ) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
  disconnectLinear: () => Promise<void>
  fetchLinearIssue: (id: string) => Promise<LinearIssue | null>
  searchLinearIssues: (query: string, limit?: number) => Promise<LinearIssue[]>
  listLinearIssues: (
    filter?: 'assigned' | 'created' | 'all' | 'completed',
    limit?: number
  ) => Promise<LinearIssue[]>
  patchLinearIssue: (issueId: string, patch: Partial<LinearIssue>) => void
}

export const createLinearSlice: StateCreator<AppState, [], [], LinearSlice> = (set, get) => ({
  linearStatus: { connected: false, viewer: null },
  linearStatusChecked: false,
  linearIssueCache: {},
  linearSearchCache: {},

  checkLinearConnection: async () => {
    try {
      const status = (await window.api.linear.status()) as LinearConnectionStatus
      const prev = get().linearStatus
      if (prev.connected !== status.connected || prev.viewer?.email !== status.viewer?.email) {
        set({ linearStatus: status, linearStatusChecked: true })
      } else if (!get().linearStatusChecked) {
        set({ linearStatusChecked: true })
      }
    } catch {
      if (get().linearStatus.connected) {
        set({ linearStatus: { connected: false, viewer: null }, linearStatusChecked: true })
      } else if (!get().linearStatusChecked) {
        set({ linearStatusChecked: true })
      }
    }
  },

  connectLinear: async (apiKey: string) => {
    try {
      const result = await window.api.linear.connect({ apiKey })
      if (result.ok) {
        set({
          linearStatus: {
            connected: true,
            viewer: result.viewer as LinearViewer
          }
        })
      }
      return result as { ok: true; viewer: LinearViewer } | { ok: false; error: string }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  disconnectLinear: async () => {
    await window.api.linear.disconnect()
    inflightIssueRequests.clear()
    inflightSearchRequests.clear()
    inflightListRequests.clear()
    clearLinearMetadataCache()
    set({
      linearStatus: { connected: false, viewer: null },
      linearIssueCache: {},
      linearSearchCache: {}
    })
  },

  fetchLinearIssue: async (id: string) => {
    const cached = get().linearIssueCache[id]
    if (isFresh(cached)) {
      return cached.data
    }

    const inflight = inflightIssueRequests.get(id)
    if (inflight) {
      return inflight
    }

    const promise = window.api.linear
      .getIssue({ id })
      .then((issue) => {
        const data = issue as LinearIssue | null
        set((s) => ({
          linearIssueCache: evictStaleEntries({
            ...s.linearIssueCache,
            [id]: { data, fetchedAt: Date.now() }
          })
        }))
        return data
      })
      .catch((error) => {
        console.warn('[linear] fetchLinearIssue failed:', error)
        if (looksLikeAuthError(error)) {
          set({ linearStatus: { connected: false, viewer: null } })
        }
        return null
      })
      .finally(() => {
        inflightIssueRequests.delete(id)
      })

    inflightIssueRequests.set(id, promise)
    return promise
  },

  searchLinearIssues: async (query: string, limit = 20) => {
    const cacheKey = `${query}::${limit}`
    const cached = get().linearSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }

    const inflight = inflightSearchRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }

    const promise = window.api.linear
      .searchIssues({ query, limit })
      .then((issues) => {
        const data = issues as LinearIssue[]
        set((s) => ({
          linearSearchCache: evictStaleEntries({
            ...s.linearSearchCache,
            [cacheKey]: { data, fetchedAt: Date.now() }
          })
        }))
        return data
      })
      .catch((error) => {
        console.warn('[linear] searchLinearIssues failed:', error)
        if (looksLikeAuthError(error)) {
          set({ linearStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        inflightSearchRequests.delete(cacheKey)
      })

    inflightSearchRequests.set(cacheKey, promise)
    return promise
  },

  listLinearIssues: async (filter = 'assigned', limit = 20) => {
    const cacheKey = `list::${filter}::${limit}`
    const cached = get().linearSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }

    const inflight = inflightListRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }

    const promise = window.api.linear
      .listIssues({ filter, limit })
      .then((issues) => {
        const data = issues as LinearIssue[]
        set((s) => ({
          linearSearchCache: evictStaleEntries({
            ...s.linearSearchCache,
            [cacheKey]: { data, fetchedAt: Date.now() }
          })
        }))
        return data
      })
      .catch((error) => {
        console.warn('[linear] listLinearIssues failed:', error)
        if (looksLikeAuthError(error)) {
          set({ linearStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        inflightListRequests.delete(cacheKey)
      })

    inflightListRequests.set(cacheKey, promise)
    return promise
  },

  patchLinearIssue: (issueId, patch) => {
    set((s) => {
      let changed = false

      const nextIssueCache = { ...s.linearIssueCache }
      const issueEntry = nextIssueCache[issueId]
      if (issueEntry?.data) {
        // Why: set fetchedAt to 0 so the next fetchLinearIssue call
        // actually hits IPC instead of returning the stale optimistic data.
        nextIssueCache[issueId] = {
          ...issueEntry,
          data: { ...issueEntry.data, ...patch },
          fetchedAt: 0
        }
        changed = true
      }

      const nextSearchCache = { ...s.linearSearchCache }
      for (const key of Object.keys(nextSearchCache)) {
        const entry = nextSearchCache[key]
        if (!entry?.data) {
          continue
        }
        const idx = entry.data.findIndex((item) => item.id === issueId)
        if (idx === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[idx] = { ...updatedItems[idx], ...patch }
        nextSearchCache[key] = { ...entry, data: updatedItems }
        changed = true
      }

      return changed ? { linearIssueCache: nextIssueCache, linearSearchCache: nextSearchCache } : {}
    })
  }
})
