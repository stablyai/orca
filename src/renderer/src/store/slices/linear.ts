/* eslint-disable max-lines -- Why: the Linear slice owns status, workspace
   selection, issue caches, and optimistic patch propagation as one store
   boundary so cache invalidation stays coherent. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  LinearViewer,
  LinearConnectionStatus,
  LinearIssue,
  LinearTeam,
  LinearWorkspace,
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
  linearListTeams,
  linearSearchIssues,
  linearSelectWorkspace,
  linearStatus,
  linearTestConnection
} from '@/runtime/runtime-linear-client'

const CACHE_TTL = 60_000 // 60s — same as GitHub work-items revalidation TTL
const TEAM_CACHE_TTL = 10 * 60_000 // Teams change rarely and block visible Linear rows.
const MAX_CACHE_ENTRIES = 500

function isFresh<T>(entry: CacheEntry<T> | undefined, ttl = CACHE_TTL): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
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

type InflightLinearIssueRequest = {
  promise: Promise<LinearIssue | null>
  generation: number
}

const inflightIssueRequests = new Map<string, InflightLinearIssueRequest>()
type InflightLinearListRequest = {
  promise: Promise<LinearIssue[]>
  force: boolean
  generation: number
}

const inflightSearchRequests = new Map<string, InflightLinearListRequest>()
const inflightListRequests = new Map<string, InflightLinearListRequest>()
type InflightLinearTeamRequest = {
  promise: Promise<LinearTeam[]>
  force: boolean
  generation: number
}

const inflightTeamRequests = new Map<string, InflightLinearTeamRequest>()
let inflightStatusRequest: Promise<void> | null = null
let statusRequestGeneration = 0
let linearCacheGeneration = 0

function getSelectedWorkspaceId(status: LinearConnectionStatus): LinearWorkspaceSelection | null {
  return status.selectedWorkspaceId ?? status.activeWorkspaceId ?? null
}

function linearSearchCacheKey(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  query: string,
  limit: number
): string {
  return `${workspaceId ?? 'default'}::search::${query}::${limit}`
}

function linearListCacheKey(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  filter: 'assigned' | 'created' | 'all' | 'completed',
  limit: number
): string {
  return `${workspaceId ?? 'default'}::list::${filter}::${limit}`
}

function linearTeamsCacheKey(workspaceId: LinearWorkspaceSelection | null | undefined): string {
  return `${workspaceId ?? 'default'}::teams`
}

function linearWorkspaceSignature(workspace: LinearWorkspace): string {
  return [
    workspace.id,
    workspace.organizationId,
    workspace.organizationName,
    workspace.organizationUrlKey ?? '',
    workspace.displayName,
    workspace.email ?? '',
    workspace.credentialRevision ?? 0
  ].join('\u001f')
}

function linearStatusScopeSignature(status: LinearConnectionStatus): string {
  return JSON.stringify({
    connected: status.connected,
    activeWorkspaceId: status.activeWorkspaceId ?? null,
    selectedWorkspaceId: getSelectedWorkspaceId(status),
    viewer: status.viewer
      ? [
          status.viewer.organizationId ?? '',
          status.viewer.organizationName,
          status.viewer.organizationUrlKey ?? '',
          status.viewer.displayName,
          status.viewer.email ?? ''
        ]
      : null,
    workspaces: (status.workspaces ?? []).map(linearWorkspaceSignature)
  })
}

function clearLinearRequestMaps(): void {
  inflightIssueRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
  inflightTeamRequests.clear()
}

function invalidateLinearCaches(): void {
  linearCacheGeneration += 1
  clearLinearRequestMaps()
  clearLinearMetadataCache()
}

function shouldRefreshStatusAfterRead(
  workspaceId: LinearWorkspaceSelection | null | undefined
): boolean {
  return workspaceId === 'all'
}

type LinearIssueReadArgs =
  | { kind: 'search'; query: string; limit?: number }
  | { kind: 'list'; filter?: 'assigned' | 'created' | 'all' | 'completed'; limit?: number }

type LinearFetchOptions = { force?: boolean }

function beginStatusOperation(): number {
  statusRequestGeneration += 1
  inflightStatusRequest = null
  return statusRequestGeneration
}

function isCurrentStatusOperation(generation: number): boolean {
  return generation === statusRequestGeneration
}

export type LinearSlice = {
  linearStatus: LinearConnectionStatus
  linearStatusChecked: boolean
  linearIssueCache: Record<string, CacheEntry<LinearIssue>>
  linearSearchCache: Record<string, CacheEntry<LinearIssue[]>>
  linearTeamCache: Record<string, CacheEntry<LinearTeam[]>>

  checkLinearConnection: (force?: boolean) => Promise<void>
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
  getCachedLinearIssues: (args: LinearIssueReadArgs) => LinearIssue[] | null
  prefetchLinearIssues: (args: LinearIssueReadArgs) => void
  searchLinearIssues: (
    query: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue[]>
  listLinearIssues: (
    filter?: 'assigned' | 'created' | 'all' | 'completed',
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue[]>
  getCachedLinearTeams: (workspaceId?: LinearWorkspaceSelection | null) => LinearTeam[] | null
  listLinearTeams: (
    workspaceId?: LinearWorkspaceSelection | null,
    options?: LinearFetchOptions
  ) => Promise<LinearTeam[]>
  patchLinearIssue: (issueId: string, patch: Partial<LinearIssue>) => void
}

export const createLinearSlice: StateCreator<AppState, [], [], LinearSlice> = (set, get) => ({
  linearStatus: { connected: false, viewer: null },
  linearStatusChecked: false,
  linearIssueCache: {},
  linearSearchCache: {},
  linearTeamCache: {},

  checkLinearConnection: async (force = false) => {
    if (inflightStatusRequest && !force) {
      return inflightStatusRequest
    }

    const requestGeneration = beginStatusOperation()
    inflightStatusRequest = linearStatus(get().settings)
      .then((status) => {
        if (!isCurrentStatusOperation(requestGeneration)) {
          return
        }
        const typedStatus = status as LinearConnectionStatus
        const prev = get().linearStatus
        const prevScopeSignature = linearStatusScopeSignature(prev)
        const nextScopeSignature = linearStatusScopeSignature(typedStatus)
        if (prevScopeSignature !== nextScopeSignature) {
          invalidateLinearCaches()
          set({
            linearStatus: typedStatus,
            linearIssueCache: {},
            linearSearchCache: {},
            linearTeamCache: {},
            linearStatusChecked: true
          })
        } else if (!get().linearStatusChecked) {
          set({ linearStatusChecked: true })
        }
      })
      .catch(() => {
        if (!isCurrentStatusOperation(requestGeneration)) {
          return
        }
        if (get().linearStatus.connected) {
          set({ linearStatus: { connected: false, viewer: null }, linearStatusChecked: true })
        } else if (!get().linearStatusChecked) {
          set({ linearStatusChecked: true })
        }
      })
      .finally(() => {
        if (isCurrentStatusOperation(requestGeneration)) {
          inflightStatusRequest = null
        }
      })

    return inflightStatusRequest
  },

  testLinearConnection: async (workspaceId) => {
    const requestGeneration = beginStatusOperation()
    try {
      const result = (await linearTestConnection(get().settings, workspaceId)) as
        | { ok: true; viewer: LinearViewer }
        | { ok: false; error: string }
      const status = await linearStatus(get().settings)
      if (isCurrentStatusOperation(requestGeneration)) {
        const prev = get().linearStatus
        if (linearStatusScopeSignature(prev) !== linearStatusScopeSignature(status)) {
          invalidateLinearCaches()
          set({
            linearStatus: status,
            linearIssueCache: {},
            linearSearchCache: {},
            linearTeamCache: {},
            linearStatusChecked: true
          })
        } else {
          set({ linearStatus: status, linearStatusChecked: true })
        }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  connectLinear: async (apiKey: string) => {
    const requestGeneration = beginStatusOperation()
    try {
      const result = await linearConnect(get().settings, apiKey)
      if (result.ok && isCurrentStatusOperation(requestGeneration)) {
        invalidateLinearCaches()
        set({
          linearIssueCache: {},
          linearSearchCache: {},
          linearTeamCache: {}
        })
        const status = await linearStatus(get().settings)
        if (!isCurrentStatusOperation(requestGeneration)) {
          return result as { ok: true; viewer: LinearViewer } | { ok: false; error: string }
        }
        set({
          linearStatus: status,
          linearStatusChecked: true
        })
      }
      return result as { ok: true; viewer: LinearViewer } | { ok: false; error: string }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  selectLinearWorkspace: async (workspaceId) => {
    const requestGeneration = beginStatusOperation()
    const status = await linearSelectWorkspace(get().settings, workspaceId)
    if (!isCurrentStatusOperation(requestGeneration)) {
      return
    }
    invalidateLinearCaches()
    set({
      linearStatus: status,
      linearIssueCache: {},
      linearSearchCache: {},
      linearTeamCache: {},
      linearStatusChecked: true
    })
  },

  disconnectLinear: async () => {
    const requestGeneration = beginStatusOperation()
    await linearDisconnect(get().settings)
    if (!isCurrentStatusOperation(requestGeneration)) {
      return
    }
    invalidateLinearCaches()
    set({
      linearStatus: { connected: false, viewer: null },
      linearIssueCache: {},
      linearSearchCache: {},
      linearTeamCache: {},
      linearStatusChecked: true
    })
  },

  disconnectLinearWorkspace: async (workspaceId) => {
    const requestGeneration = beginStatusOperation()
    await linearDisconnectWorkspace(get().settings, workspaceId)
    const status = await linearStatus(get().settings)
    if (!isCurrentStatusOperation(requestGeneration)) {
      return
    }
    invalidateLinearCaches()
    set({
      linearStatus: status,
      linearIssueCache: {},
      linearSearchCache: {},
      linearTeamCache: {},
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
      return inflight.promise
    }

    let entry: InflightLinearIssueRequest
    const requestCacheGeneration = linearCacheGeneration
    const promise = linearGetIssue(get().settings, id, workspaceId)
      .then((issue) => {
        const data = issue as LinearIssue | null
        if (
          inflightIssueRequests.get(issueCacheKey) === entry &&
          requestCacheGeneration === linearCacheGeneration
        ) {
          set((s) => ({
            linearIssueCache: evictStaleEntries({
              ...s.linearIssueCache,
              [issueCacheKey]: { data, fetchedAt: Date.now() }
            })
          }))
        }
        return data
      })
      .catch((error) => {
        console.warn('[linear] fetchLinearIssue failed:', error)
        if (looksLikeAuthError(error)) {
          void get().checkLinearConnection(true)
        }
        return null
      })
      .finally(() => {
        if (inflightIssueRequests.get(issueCacheKey) === entry) {
          inflightIssueRequests.delete(issueCacheKey)
        }
      })

    entry = { promise, generation: requestCacheGeneration }
    inflightIssueRequests.set(issueCacheKey, entry)
    return promise
  },

  getCachedLinearIssues: (args) => {
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const limit = args.limit ?? 20
    const cacheKey =
      args.kind === 'search'
        ? linearSearchCacheKey(workspaceId, args.query, limit)
        : linearListCacheKey(workspaceId, args.filter ?? 'assigned', limit)
    return get().linearSearchCache[cacheKey]?.data ?? null
  },

  prefetchLinearIssues: (args) => {
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const limit = args.limit ?? 20
    const cacheKey =
      args.kind === 'search'
        ? linearSearchCacheKey(workspaceId, args.query, limit)
        : linearListCacheKey(workspaceId, args.filter ?? 'assigned', limit)
    if (
      isFresh(get().linearSearchCache[cacheKey]) ||
      inflightSearchRequests.has(cacheKey) ||
      inflightListRequests.has(cacheKey)
    ) {
      return
    }
    const promise =
      args.kind === 'search'
        ? get().searchLinearIssues(args.query, limit)
        : get().listLinearIssues(args.filter, limit)
    void promise.catch(() => {})
  },

  searchLinearIssues: async (query: string, limit = 20, options) => {
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = linearSearchCacheKey(workspaceId, query, limit)
    const cached = get().linearSearchCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }

    const inflight = inflightSearchRequests.get(cacheKey)
    if (inflight && (!options?.force || inflight.force)) {
      return inflight.promise
    }

    let entry: InflightLinearListRequest
    const requestCacheGeneration = linearCacheGeneration
    const promise = linearSearchIssues(get().settings, query, limit, workspaceId)
      .then((issues) => {
        const data = issues as LinearIssue[]
        if (
          inflightSearchRequests.get(cacheKey) === entry &&
          requestCacheGeneration === linearCacheGeneration
        ) {
          set((s) => ({
            linearSearchCache: evictStaleEntries({
              ...s.linearSearchCache,
              [cacheKey]: { data, fetchedAt: Date.now() }
            })
          }))
        }
        return data
      })
      .catch((error) => {
        console.warn('[linear] searchLinearIssues failed:', error)
        if (looksLikeAuthError(error)) {
          if (!shouldRefreshStatusAfterRead(workspaceId)) {
            void get().checkLinearConnection(true)
          }
          return []
        }
        return get().linearSearchCache[cacheKey]?.data ?? []
      })
      .finally(() => {
        if (inflightSearchRequests.get(cacheKey) === entry) {
          inflightSearchRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId) &&
          requestCacheGeneration === linearCacheGeneration
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = { promise, force: Boolean(options?.force), generation: requestCacheGeneration }
    inflightSearchRequests.set(cacheKey, entry)
    return promise
  },

  listLinearIssues: async (filter = 'assigned', limit = 20, options) => {
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = linearListCacheKey(workspaceId, filter, limit)
    const cached = get().linearSearchCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }

    const inflight = inflightListRequests.get(cacheKey)
    if (inflight && (!options?.force || inflight.force)) {
      return inflight.promise
    }

    let entry: InflightLinearListRequest
    const requestCacheGeneration = linearCacheGeneration
    const promise = linearListIssues(get().settings, filter, limit, workspaceId)
      .then((issues) => {
        const data = issues as LinearIssue[]
        if (
          inflightListRequests.get(cacheKey) === entry &&
          requestCacheGeneration === linearCacheGeneration
        ) {
          set((s) => ({
            linearSearchCache: evictStaleEntries({
              ...s.linearSearchCache,
              [cacheKey]: { data, fetchedAt: Date.now() }
            })
          }))
        }
        return data
      })
      .catch((error) => {
        console.warn('[linear] listLinearIssues failed:', error)
        if (looksLikeAuthError(error)) {
          if (!shouldRefreshStatusAfterRead(workspaceId)) {
            void get().checkLinearConnection(true)
          }
          return []
        }
        return get().linearSearchCache[cacheKey]?.data ?? []
      })
      .finally(() => {
        if (inflightListRequests.get(cacheKey) === entry) {
          inflightListRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId) &&
          requestCacheGeneration === linearCacheGeneration
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = { promise, force: Boolean(options?.force), generation: requestCacheGeneration }
    inflightListRequests.set(cacheKey, entry)
    return promise
  },

  getCachedLinearTeams: (workspaceId) => {
    const key = linearTeamsCacheKey(workspaceId ?? getSelectedWorkspaceId(get().linearStatus))
    return get().linearTeamCache[key]?.data ?? null
  },

  listLinearTeams: async (workspaceId, options) => {
    const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = linearTeamsCacheKey(resolvedWorkspaceId)
    const cached = get().linearTeamCache[cacheKey]
    if (!options?.force && isFresh(cached, TEAM_CACHE_TTL)) {
      return cached.data ?? []
    }

    const inflight = inflightTeamRequests.get(cacheKey)
    if (inflight && (!options?.force || inflight.force)) {
      return inflight.promise
    }

    let entry: InflightLinearTeamRequest
    const requestCacheGeneration = linearCacheGeneration
    const promise = linearListTeams(get().settings, resolvedWorkspaceId)
      .then((teams) => {
        const data = teams as LinearTeam[]
        if (
          inflightTeamRequests.get(cacheKey) === entry &&
          requestCacheGeneration === linearCacheGeneration
        ) {
          set((s) => ({
            linearTeamCache: evictStaleEntries({
              ...s.linearTeamCache,
              [cacheKey]: { data, fetchedAt: Date.now() }
            })
          }))
        }
        return data
      })
      .catch((error) => {
        console.warn('[linear] listLinearTeams failed:', error)
        if (looksLikeAuthError(error)) {
          if (!shouldRefreshStatusAfterRead(resolvedWorkspaceId)) {
            void get().checkLinearConnection(true)
          }
          return []
        }
        return get().linearTeamCache[cacheKey]?.data ?? []
      })
      .finally(() => {
        if (inflightTeamRequests.get(cacheKey) === entry) {
          inflightTeamRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(resolvedWorkspaceId) &&
          requestCacheGeneration === linearCacheGeneration
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = { promise, force: Boolean(options?.force), generation: requestCacheGeneration }
    inflightTeamRequests.set(cacheKey, entry)
    return promise
  },

  patchLinearIssue: (issueId, patch) => {
    set((s) => {
      let changed = false

      const nextIssueCache = { ...s.linearIssueCache }
      for (const [key, issueEntry] of Object.entries(nextIssueCache)) {
        if (issueEntry?.data?.id !== issueId) {
          continue
        }
        // Why: set fetchedAt to 0 so the next fetchLinearIssue call
        // actually hits IPC instead of returning the stale optimistic data.
        nextIssueCache[key] = {
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
