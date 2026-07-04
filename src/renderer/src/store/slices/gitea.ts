import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { CacheEntry } from './github'
import type {
  GiteaConnectionStatus,
  GiteaIssue,
  GiteaIssueUpdate,
  GiteaMutationResult,
  GiteaServerSelection,
  GiteaWorkItem,
  GiteaWorkItemFilter
} from '../../../../shared/types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

// Gitea is a repo-scoped task source (like GitLab): the renderer calls
// window.api.gitea directly and the main process resolves the SSH connection
// from the repo, so no runtime client is needed. Connection credentials live
// on the local machine, so status reads are local too.

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 300

export type GiteaIssueScope = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

export type GiteaSlice = {
  giteaStatus: GiteaConnectionStatus | null
  giteaStatusLoaded: boolean
  giteaWorkItems: Record<string, CacheEntry<GiteaWorkItem[]>>
  giteaIssueDetail: Record<string, CacheEntry<GiteaIssue | null>>
  refreshGiteaStatus: () => Promise<GiteaConnectionStatus | null>
  giteaConnect: (args: {
    baseUrl: string
    token: string
  }) => Promise<{ ok: boolean; error?: string }>
  giteaDisconnect: (serverId?: string) => Promise<void>
  giteaSelectServer: (serverId: GiteaServerSelection) => Promise<GiteaConnectionStatus | null>
  giteaTestConnection: (serverId?: string) => Promise<{ ok: boolean; error?: string }>
  fetchGiteaWorkItems: (
    scope: GiteaIssueScope,
    filter?: GiteaWorkItemFilter,
    limit?: number
  ) => Promise<GiteaWorkItem[]>
  fetchGiteaIssue: (scope: GiteaIssueScope, issueNumber: number) => Promise<GiteaIssue | null>
  createGiteaIssue: (
    scope: GiteaIssueScope,
    input: { title: string; body?: string; assignees?: string[]; labelIds?: number[] }
  ) => Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }>
  updateGiteaIssue: (
    scope: GiteaIssueScope,
    issueNumber: number,
    updates: GiteaIssueUpdate
  ) => Promise<GiteaMutationResult>
  addGiteaIssueComment: (
    scope: GiteaIssueScope,
    issueNumber: number,
    body: string
  ) => Promise<GiteaMutationResult>
}

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

function evictStale<T>(cache: Record<string, CacheEntry<T>>): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_CACHE_ENTRIES) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const key of sorted.slice(sorted.length - MAX_CACHE_ENTRIES)) {
    pruned[key] = cache[key]
  }
  return pruned
}

// Why: namespace cache keys by server context so reads don't bleed across
// server selections. An explicit sourceContext pins the server; otherwise the
// active server (falling back to the explicit selection, then 'all') scopes the
// key — keying on activeServerId keeps two single-server states distinct, so
// reconnecting to a different host can't reuse the previous server's cache.
function scopeKey(
  scope: GiteaIssueScope,
  status?: Pick<GiteaConnectionStatus, 'activeServerId' | 'selectedServerId'> | null
): string {
  const repoKey = scope.repoId?.trim() || scope.repoPath
  const serverKey = scope.sourceContext
    ? JSON.stringify(scope.sourceContext)
    : `active:${status?.activeServerId ?? status?.selectedServerId ?? 'all'}`
  return `${repoKey}@${serverKey}`
}

function requestArgs(scope: GiteaIssueScope): {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
} {
  return {
    repoPath: scope.repoPath,
    repoId: scope.repoId ?? null,
    sourceContext: scope.sourceContext ?? null
  }
}

export const createGiteaSlice: StateCreator<AppState, [], [], GiteaSlice> = (set, get) => ({
  giteaStatus: null,
  giteaStatusLoaded: false,
  giteaWorkItems: {},
  giteaIssueDetail: {},

  refreshGiteaStatus: async () => {
    try {
      const status = (await window.api.gitea.status()) as GiteaConnectionStatus
      set({ giteaStatus: status, giteaStatusLoaded: true })
      return status
    } catch {
      set({ giteaStatusLoaded: true })
      return get().giteaStatus
    }
  },

  giteaConnect: async (args) => {
    const result = await window.api.gitea.connect(args)
    if (result.ok) {
      await get().refreshGiteaStatus()
    }
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  },

  giteaDisconnect: async (serverId) => {
    await window.api.gitea.disconnect(serverId ? { serverId } : undefined)
    await get().refreshGiteaStatus()
  },

  giteaSelectServer: async (serverId) => {
    const status = (await window.api.gitea.selectServer({ serverId })) as GiteaConnectionStatus
    // Why: drop caches keyed by the previous selection so a server switch can't
    // serve stale data until TTL expiry.
    set({
      giteaStatus: status,
      giteaStatusLoaded: true,
      giteaWorkItems: {},
      giteaIssueDetail: {}
    })
    return status
  },

  giteaTestConnection: async (serverId) => {
    const result = await window.api.gitea.testConnection(serverId ? { serverId } : undefined)
    // A test can surface a per-server decrypt error, so refresh status alongside.
    await get().refreshGiteaStatus()
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  },

  fetchGiteaWorkItems: async (scope, filter, limit) => {
    const limitKey = typeof limit === 'number' ? String(limit) : 'default'
    const key = `${scopeKey(scope, get().giteaStatus)}:${filter ?? 'all'}:${limitKey}`
    const cached = get().giteaWorkItems[key]
    if (isFresh(cached) && cached.data) {
      return cached.data
    }
    const items = (await window.api.gitea.listWorkItems({
      ...requestArgs(scope),
      filter,
      limit
    })) as GiteaWorkItem[]
    set((state) => ({
      giteaWorkItems: evictStale({
        ...state.giteaWorkItems,
        [key]: { data: items, fetchedAt: Date.now() }
      })
    }))
    return items
  },

  fetchGiteaIssue: async (scope, issueNumber) => {
    const key = `${scopeKey(scope, get().giteaStatus)}#${issueNumber}`
    const cached = get().giteaIssueDetail[key]
    if (isFresh(cached)) {
      return cached.data
    }
    const issue = (await window.api.gitea.issue({
      ...requestArgs(scope),
      number: issueNumber
    })) as GiteaIssue | null
    set((state) => ({
      giteaIssueDetail: evictStale({
        ...state.giteaIssueDetail,
        [key]: { data: issue, fetchedAt: Date.now() }
      })
    }))
    return issue
  },

  createGiteaIssue: async (scope, input) => {
    const result = await window.api.gitea.createIssue({ ...requestArgs(scope), ...input })
    if (result.ok) {
      // Invalidate cached lists for this repo so the new issue appears.
      const prefix = `${scopeKey(scope, get().giteaStatus)}:`
      set((state) => ({
        giteaWorkItems: Object.fromEntries(
          Object.entries(state.giteaWorkItems).filter(([key]) => !key.startsWith(prefix))
        )
      }))
      return { ok: true, number: result.number, url: result.url }
    }
    return { ok: false, error: result.error }
  },

  updateGiteaIssue: async (scope, issueNumber, updates) => {
    const result = await window.api.gitea.updateIssue({
      ...requestArgs(scope),
      number: issueNumber,
      updates
    })
    if (result.ok) {
      const scopePrefix = scopeKey(scope, get().giteaStatus)
      const detailKey = `${scopePrefix}#${issueNumber}`
      // Why: the task list renders title/state/labels from the work-item cache,
      // so dropping only the detail entry would leave the list stale until TTL.
      const listPrefix = `${scopePrefix}:`
      set((state) => ({
        giteaIssueDetail: Object.fromEntries(
          Object.entries(state.giteaIssueDetail).filter(([key]) => key !== detailKey)
        ),
        giteaWorkItems: Object.fromEntries(
          Object.entries(state.giteaWorkItems).filter(([key]) => !key.startsWith(listPrefix))
        )
      }))
    }
    return result
  },

  addGiteaIssueComment: async (scope, issueNumber, body) => {
    return window.api.gitea.addIssueComment({ ...requestArgs(scope), number: issueNumber, body })
  }
})
