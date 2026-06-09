/* eslint-disable max-lines -- Why: the Asana slice owns workspace status, task
   caches, and optimistic patch propagation as one store boundary so active
   workspace changes invalidate every related query coherently. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  AsanaConnectionStatus,
  AsanaTask,
  AsanaTaskFilter,
  AsanaViewer,
  AsanaWorkspaceSelection
} from '../../../../shared/types'
import type { CacheEntry } from './github'
import {
  asanaConnect,
  asanaDisconnect,
  asanaGetTask,
  asanaListTasks,
  asanaSearchTasks,
  asanaSelectWorkspace,
  asanaStatus,
  asanaTestConnection
} from '@/runtime/runtime-asana-client'

const CACHE_TTL = 60_000
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
  return /authenticat|unauthorized|forbidden|401|403/i.test(msg)
}

const inflightTaskRequests = new Map<string, Promise<AsanaTask | null>>()
const inflightSearchRequests = new Map<string, Promise<AsanaTask[]>>()
const inflightListRequests = new Map<string, Promise<AsanaTask[]>>()

function getSelectedWorkspaceId(status: AsanaConnectionStatus): AsanaWorkspaceSelection | null {
  return status.selectedWorkspaceId ?? status.activeWorkspaceId ?? null
}

function clearAsanaInflight(): void {
  inflightTaskRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

export type AsanaSlice = {
  asanaStatus: AsanaConnectionStatus
  asanaStatusChecked: boolean
  asanaTaskCache: Record<string, CacheEntry<AsanaTask>>
  asanaSearchCache: Record<string, CacheEntry<AsanaTask[]>>

  checkAsanaConnection: () => Promise<void>
  connectAsana: (args: {
    apiToken: string
  }) => Promise<{ ok: true; viewer: AsanaViewer } | { ok: false; error: string }>
  testAsanaConnection: (
    workspaceId?: string | null
  ) => Promise<{ ok: true; viewer: AsanaViewer } | { ok: false; error: string }>
  selectAsanaWorkspace: (workspaceId: AsanaWorkspaceSelection) => Promise<void>
  disconnectAsana: (workspaceId?: string | null) => Promise<void>
  fetchAsanaTask: (gid: string, workspaceId?: string | null) => Promise<AsanaTask | null>
  searchAsanaTasks: (query: string, limit?: number) => Promise<AsanaTask[]>
  listAsanaTasks: (
    filter?: AsanaTaskFilter,
    limit?: number,
    projectId?: string | null
  ) => Promise<AsanaTask[]>
  patchAsanaTask: (gid: string, patch: Partial<AsanaTask>) => void
}

export const createAsanaSlice: StateCreator<AppState, [], [], AsanaSlice> = (set, get) => ({
  asanaStatus: { connected: false, viewer: null },
  asanaStatusChecked: false,
  asanaTaskCache: {},
  asanaSearchCache: {},

  checkAsanaConnection: async () => {
    try {
      const status = await asanaStatus(get().settings)
      const prev = get().asanaStatus
      if (
        prev.connected !== status.connected ||
        prev.viewer?.email !== status.viewer?.email ||
        getSelectedWorkspaceId(prev) !== getSelectedWorkspaceId(status) ||
        (prev.workspaces?.length ?? 0) !== (status.workspaces?.length ?? 0)
      ) {
        set({ asanaStatus: status, asanaStatusChecked: true })
      } else if (!get().asanaStatusChecked) {
        set({ asanaStatusChecked: true })
      }
    } catch {
      if (get().asanaStatus.connected) {
        set({ asanaStatus: { connected: false, viewer: null }, asanaStatusChecked: true })
      } else if (!get().asanaStatusChecked) {
        set({ asanaStatusChecked: true })
      }
    }
  },

  connectAsana: async (args) => {
    try {
      const result = await asanaConnect(get().settings, args)
      if (result.ok) {
        set({ asanaStatus: { connected: true, viewer: result.viewer }, asanaStatusChecked: true })
        void get().checkAsanaConnection()
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  testAsanaConnection: async (workspaceId) => {
    try {
      const result = await asanaTestConnection(get().settings, workspaceId)
      const status = await asanaStatus(get().settings)
      set({ asanaStatus: status, asanaStatusChecked: true })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  selectAsanaWorkspace: async (workspaceId) => {
    const status = await asanaSelectWorkspace(get().settings, workspaceId)
    clearAsanaInflight()
    set({
      asanaStatus: status,
      asanaTaskCache: {},
      asanaSearchCache: {},
      asanaStatusChecked: true
    })
  },

  disconnectAsana: async (workspaceId) => {
    await asanaDisconnect(get().settings, workspaceId)
    clearAsanaInflight()
    const status = await asanaStatus(get().settings)
    set({
      asanaStatus: status.connected ? status : { connected: false, viewer: null },
      asanaTaskCache: {},
      asanaSearchCache: {},
      asanaStatusChecked: true
    })
  },

  fetchAsanaTask: async (gid, workspaceId) => {
    const taskCacheKey = `${workspaceId ?? 'selected'}::${gid}`
    const cached = get().asanaTaskCache[taskCacheKey] ?? get().asanaTaskCache[gid]
    if (isFresh(cached)) {
      return cached.data
    }
    const inflight = inflightTaskRequests.get(taskCacheKey)
    if (inflight) {
      return inflight
    }
    const promise = asanaGetTask(get().settings, gid, workspaceId)
      .then((task) => {
        set((s) => ({
          asanaTaskCache: evictStaleEntries({
            ...s.asanaTaskCache,
            [taskCacheKey]: { data: task, fetchedAt: Date.now() }
          })
        }))
        return task
      })
      .catch((error) => {
        console.warn('[asana] fetchAsanaTask failed:', error)
        if (looksLikeAuthError(error)) {
          set({ asanaStatus: { connected: false, viewer: null } })
        }
        return null
      })
      .finally(() => {
        inflightTaskRequests.delete(taskCacheKey)
      })
    inflightTaskRequests.set(taskCacheKey, promise)
    return promise
  },

  searchAsanaTasks: async (query, limit = 30) => {
    const workspaceId = getSelectedWorkspaceId(get().asanaStatus)
    const cacheKey = `${workspaceId ?? 'default'}::${query}::${limit}`
    const cached = get().asanaSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightSearchRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }
    const promise = asanaSearchTasks(get().settings, query, limit, workspaceId)
      .then((tasks) => {
        set((s) => ({
          asanaSearchCache: evictStaleEntries({
            ...s.asanaSearchCache,
            [cacheKey]: { data: tasks, fetchedAt: Date.now() }
          })
        }))
        return tasks
      })
      .catch((error) => {
        console.warn('[asana] searchAsanaTasks failed:', error)
        if (looksLikeAuthError(error)) {
          set({ asanaStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        inflightSearchRequests.delete(cacheKey)
      })
    inflightSearchRequests.set(cacheKey, promise)
    return promise
  },

  listAsanaTasks: async (filter = 'assigned', limit = 30, projectId = null) => {
    const workspaceId = getSelectedWorkspaceId(get().asanaStatus)
    const cacheKey = `${workspaceId ?? 'default'}::list::${filter}::${limit}::${projectId ?? 'all'}`
    const cached = get().asanaSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (inflight) {
      return inflight
    }
    const promise = asanaListTasks(get().settings, filter, limit, workspaceId, projectId)
      .then((tasks) => {
        set((s) => ({
          asanaSearchCache: evictStaleEntries({
            ...s.asanaSearchCache,
            [cacheKey]: { data: tasks, fetchedAt: Date.now() }
          })
        }))
        return tasks
      })
      .catch((error) => {
        console.warn('[asana] listAsanaTasks failed:', error)
        if (looksLikeAuthError(error)) {
          set({ asanaStatus: { connected: false, viewer: null } })
        }
        return []
      })
      .finally(() => {
        inflightListRequests.delete(cacheKey)
      })
    inflightListRequests.set(cacheKey, promise)
    return promise
  },

  patchAsanaTask: (gid, patch) => {
    set((s) => {
      let changed = false
      const nextTaskCache = { ...s.asanaTaskCache }
      for (const [key, entry] of Object.entries(nextTaskCache)) {
        if (entry?.data?.gid !== gid) {
          continue
        }
        nextTaskCache[key] = { ...entry, data: { ...entry.data, ...patch }, fetchedAt: 0 }
        changed = true
      }
      const nextSearchCache = { ...s.asanaSearchCache }
      for (const key of Object.keys(nextSearchCache)) {
        const entry = nextSearchCache[key]
        if (!entry?.data) {
          continue
        }
        const index = entry.data.findIndex((task) => task.gid === gid)
        if (index === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[index] = { ...updatedItems[index], ...patch }
        nextSearchCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed ? { asanaTaskCache: nextTaskCache, asanaSearchCache: nextSearchCache } : {}
    })
  }
})
