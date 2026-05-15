/* eslint-disable max-lines -- Why: the Linear slice owns status, workspace
   selection, issue caches, and optimistic patch propagation as one store
   boundary so cache invalidation stays coherent. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  LinearViewer,
  LinearConnectionStatus,
  LinearIssue,
  LinearWorkspaceSelection
} from '../../../../shared/types'
import type { CacheEntry } from './github'
import { clearLinearMetadataCache } from '../../hooks/useIssueMetadata'
import {
  linearConnect,
  linearDisconnect,
  linearDisconnectWorkspace,
  linearGetIssue,
  linearListIssues,
  linearSearchIssues,
  linearSelectWorkspace,
  linearStatus,
  linearTestConnection
} from '@/runtime/runtime-linear-client'

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

function getSelectedWorkspaceId(status: LinearConnectionStatus): LinearWorkspaceSelection | null {
  return status.selectedWorkspaceId ?? status.activeWorkspaceId ?? null
}

export type LinearSlice = {
  linearStatus: LinearConnectionStatus
  linearStatusChecked: boolean
  linearIssueCache: Record<string, CacheEntry<LinearIssue>>
  linearSearchCache: Record<string, CacheEntry<LinearIssue[]>>

  checkLinearConnection: () => Promise<void>
  connectLinear: (
    apiKey: string
  ) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
  testLinearConnection: (
    workspaceId?: string | null
  ) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
  selectLinearWorkspace: (workspaceId: LinearWorkspaceSelection) => Promise<void>
  disconnectLinear: () => Promise<void>
  disconnectLinearWorkspace: (workspaceId: string) => Promise<void>
  fetchLinearIssue: (id: string, workspaceId?: string | null) => Promise<LinearIssue | null>
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
      const status = (await linearStatus(get().settings)) as LinearConnectionStatus
      const prev = get().linearStatus
      if (
        prev.connected !== status.connected ||
        prev.viewer?.email !== status.viewer?.email ||
        getSelectedWorkspaceId(prev) !== getSelectedWorkspaceId(status) ||
        (prev.workspaces?.length ?? 0) !== (status.workspaces?.length ?? 0)
      ) {
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

  testLinearConnection: async (workspaceId) => {
    try {
      const result = (await linearTestConnection(get().settings, workspaceId)) as
        | { ok: true; viewer: LinearViewer }
        | { ok: false; error: string }
      const status = await linearStatus(get().settings)
      set({ linearStatus: status, linearStatusChecked: true })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  connectLinear: async (apiKey: string) => {
    try {
      const result = await linearConnect(get().settings, apiKey)
      if (result.ok) {
        set({
          linearStatus: {
            connected: true,
            viewer: result.viewer as LinearViewer
          }
        })
        void get().checkLinearConnection()
      }
      return result as { ok: true; viewer: LinearViewer } | { ok: false; error: string }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  selectLinearWorkspace: async (workspaceId) => {
    const status = await linearSelectWorkspace(get().settings, workspaceId)
    inflightIssueRequests.clear()
    inflightSearchRequests.clear()
    inflightListRequests.clear()
    clearLinearMetadataCache()
    set({
      linearStatus: status,
      linearIssueCache: {},
      linearSearchCache: {},
      linearStatusChecked: true
    })
  },

  disconnectLinear: async () => {
    await linearDisconnect(get().settings)
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

  disconnectLinearWorkspace: async (workspaceId) => {
    await linearDisconnectWorkspace(get().settings, workspaceId)
    inflightIssueRequests.clear()
    inflightSearchRequests.clear()
    inflightListRequests.clear()
    clearLinearMetadataCache()
    const status = await linearStatus(get().settings)
    set({
      linearStatus: status,
      linearIssueCache: {},
      linearSearchCache: {},
      linearStatusChecked: true
    })
  },

  fetchLinearIssue: async (id: string, workspaceId?: string | null) => {
    const issueCacheKey = `${workspaceId ?? 'selected'}::${id}`
    const cached = get().linearIssueCache[issueCacheKey] ?? get().linearIssueCache[id]
    if (isFresh(cached)) {
      return cached.data
    }

    const inflight = inflightIssueRequests.get(issueCacheKey)
    if (inflight) {
      return inflight
    }

    const promise = linearGetIssue(get().settings, id, workspaceId)
      .then((issue) => {
        const data = issue as LinearIssue | null
        set((s) => ({
          linearIssueCache: evictStaleEntries({
            ...s.linearIssueCache,
            [issueCacheKey]: { data, fetchedAt: Date.now() }
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
        inflightIssueRequests.delete(issueCacheKey)
      })

    inflightIssueRequests.set(issueCacheKey, promise)
    return promise
  },

  searchLinearIssues: async (query: string, limit = 20) => {
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = `${workspaceId ?? 'default'}::${query}::${limit}`
    const cached = get().linearSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }

    const inflight = inflightSearchRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }

    const promise = linearSearchIssues(get().settings, query, limit, workspaceId)
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
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = `${workspaceId ?? 'default'}::list::${filter}::${limit}`
    const cached = get().linearSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }

    const inflight = inflightListRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }

    const promise = linearListIssues(get().settings, filter, limit, workspaceId)
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
