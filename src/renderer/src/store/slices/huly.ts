/* eslint-disable max-lines -- Why: the Huly slice owns status, connection
   selection, issue caches, and SWR mutators as one store boundary so cache
   invalidation stays coherent. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { CacheEntry } from './github'
import type {
  HulyComment,
  HulyConnectionStatus,
  HulyIssue,
  HulyIssueState,
  HulyLabel,
  HulyProjectDetail,
  HulyProjectSummary,
  HulyTeamMember,
  HulyTeamSummary,
  HulyViewer
} from '../../../../shared/types'
import {
  hulyAddComment,
  hulyConnect,
  hulyCreateIssue,
  hulyCreateProject,
  hulyDisconnect,
  hulyGetIssue,
  hulyGetProject,
  hulyListComments,
  hulyListIssues,
  hulyListProjectIssues,
  hulyListProjects,
  hulyListTeams,
  hulyPreflight,
  hulySearchIssues,
  hulySelectConnection,
  hulyStatus,
  hulyTeamLabels,
  hulyTeamMembers,
  hulyTeamStates,
  hulyUpdateIssue
} from '@/runtime/runtime-huly-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500
const inflightHulyStatusChecks = new Map<string, Promise<void>>()
const EMPTY_HULY_STATUS: HulyConnectionStatus = {
  connected: false,
  viewer: null,
  connections: [],
  activeConnectionId: null,
  selectedConnectionId: null,
  cliInstalled: false,
  cliAuthenticated: false
}

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

function pruneByPrefix<T>(
  cache: Record<string, CacheEntry<T>>,
  prefix: string
): Record<string, CacheEntry<T>> {
  if (!prefix) {
    return {}
  }
  const next: Record<string, CacheEntry<T>> = {}
  for (const [key, value] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) {
      next[key] = value
    }
  }
  return next
}

function hulyCacheScope(sourceContext?: TaskSourceContext | null): string {
  return getTaskSourceCacheScope({
    provider: 'huly',
    projectId: sourceContext?.projectId ?? '',
    hostId: sourceContext?.hostId ?? LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId: sourceContext?.projectHostSetupId ?? null,
    repoId: sourceContext?.repoId ?? null,
    providerIdentity: sourceContext?.providerIdentity ?? null
  })
}

export type HulyPreflightStatus = {
  installed: boolean
  authenticated: boolean
  cliVersion?: string
}

export type HulyFetchOptions = {
  sourceContext?: TaskSourceContext | null
  force?: boolean
  connectionId?: string | null
}

export type HulyIssueReadArgs = {
  filter?: 'assigned' | 'created' | 'all'
  limit?: number
  connectionId?: string | null
}

export type HulyConnectArgs = {
  name: string
  url: string
  workspace: string
  email: string | null
  secret: string
  token?: string | null
}

export type HulyCreateIssueArgs = {
  teamId: string
  title: string
  description?: string
  priority?: number
  stateId?: string
  assigneeId?: string | null
  labelIds?: string[]
  projectId?: string | null
  connectionId?: string | null
}

export type HulySlice = {
  hulyStatus: HulyConnectionStatus
  hulyStatusChecked: boolean
  hulyStatusChecking: boolean
  hulyPreflightStatus: HulyPreflightStatus
  hulyStatusContextKey: string | null
  hulyIssueCache: Record<string, CacheEntry<HulyIssue>>
  hulyListCache: Record<string, CacheEntry<HulyIssue[]>>
  hulyTeamCache: Record<string, CacheEntry<HulyTeamSummary[]>>
  hulyProjectCache: Record<string, CacheEntry<HulyProjectSummary[]>>
  hulyProjectDetailCache: Record<string, CacheEntry<HulyProjectDetail | null>>
  hulyCommentCache: Record<string, CacheEntry<HulyComment[]>>
  hulyTeamMembersCache: Record<string, CacheEntry<HulyTeamMember[]>>
  hulyTeamStatesCache: Record<string, CacheEntry<HulyIssueState[]>>
  hulyTeamLabelsCache: Record<string, CacheEntry<HulyLabel[]>>
  hulyListInvalidationToken: { scope: string; version: number }

  checkHulyConnection: (force?: boolean) => Promise<void>
  refreshHulyPreflight: () => Promise<void>
  connectHuly: (
    args: HulyConnectArgs
  ) => Promise<{ ok: true; viewer: HulyViewer } | { ok: false; error: string }>
  disconnectHuly: (connectionId?: string | null) => Promise<void>
  selectHulyConnection: (connectionId: string) => Promise<void>
  fetchHulyIssue: (
    id: string,
    connectionId?: string | null,
    options?: HulyFetchOptions
  ) => Promise<HulyIssue | null>
  listHulyIssues: (args: HulyIssueReadArgs, options?: HulyFetchOptions) => Promise<HulyIssue[]>
  searchHulyIssues: (
    query: string,
    limit?: number,
    options?: HulyFetchOptions
  ) => Promise<HulyIssue[]>
  createHulyIssue: (
    args: HulyCreateIssueArgs,
    options?: HulyFetchOptions
  ) => Promise<{ ok: true; issue: HulyIssue } | { ok: false; error: string }>
  updateHulyIssue: (
    id: string,
    updates: Parameters<typeof hulyUpdateIssue>[2],
    options?: HulyFetchOptions
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  addHulyComment: (
    issueId: string,
    body: string,
    options?: HulyFetchOptions
  ) => Promise<{ ok: true; comment: HulyComment } | { ok: false; error: string }>
  listHulyComments: (issueId: string, options?: HulyFetchOptions) => Promise<HulyComment[]>
  listHulyTeams: (
    connectionId?: string | null,
    options?: HulyFetchOptions
  ) => Promise<HulyTeamSummary[]>
  listHulyTeamMembers: (teamId: string, options?: HulyFetchOptions) => Promise<HulyTeamMember[]>
  listHulyTeamStates: (teamId: string, options?: HulyFetchOptions) => Promise<HulyIssueState[]>
  listHulyTeamLabels: (teamId: string, options?: HulyFetchOptions) => Promise<HulyLabel[]>
  listHulyProjects: (
    query?: string,
    limit?: number,
    options?: HulyFetchOptions
  ) => Promise<HulyProjectSummary[]>
  fetchHulyProject: (id: string, options?: HulyFetchOptions) => Promise<HulyProjectDetail | null>
  createHulyProject: (
    args: { name: string; description?: string; connectionId?: string | null },
    options?: HulyFetchOptions
  ) => Promise<{ ok: true; project: HulyProjectSummary } | { ok: false; error: string }>
  listHulyProjectIssues: (projectId: string, options?: HulyFetchOptions) => Promise<HulyIssue[]>
  invalidateHulyIssueLists: (options?: Pick<HulyFetchOptions, 'sourceContext'>) => void
  resetHulyCaches: () => void
}

function hulyCallContext(sourceContext?: TaskSourceContext | null) {
  return sourceContext ?? undefined
}

function resolveConnectionId(
  requested: string | null | undefined,
  status: HulyConnectionStatus
): string | null {
  if (requested && requested !== 'all') {
    return requested
  }
  if (status.selectedConnectionId && status.selectedConnectionId !== 'all') {
    return status.selectedConnectionId
  }
  return status.activeConnectionId ?? null
}

export const createHulySlice: StateCreator<AppState, [], [], HulySlice> = (set, get) => ({
  hulyStatus: EMPTY_HULY_STATUS,
  hulyStatusChecked: false,
  hulyStatusChecking: false,
  hulyPreflightStatus: { installed: false, authenticated: false },
  hulyStatusContextKey: null,
  hulyIssueCache: {},
  hulyListCache: {},
  hulyTeamCache: {},
  hulyProjectCache: {},
  hulyProjectDetailCache: {},
  hulyCommentCache: {},
  hulyTeamMembersCache: {},
  hulyTeamStatesCache: {},
  hulyTeamLabelsCache: {},
  hulyListInvalidationToken: { scope: '', version: 0 },

  async checkHulyConnection(force = false) {
    const settings = get().settings
    const contextKey = getProviderRuntimeContextKey(settings)
    if (!force && get().hulyStatusChecked && get().hulyStatusContextKey === contextKey) {
      return
    }
    const pending = inflightHulyStatusChecks.get(contextKey)
    if (pending) {
      await pending
      if (!force) {
        return
      }
    }
    const run = (async () => {
      set({ hulyStatusChecking: true })
      try {
        const status = await hulyStatus(hulyCallContext())
        set({
          hulyStatus: status,
          hulyStatusChecked: true,
          hulyStatusChecking: false,
          hulyStatusContextKey: contextKey
        })
      } catch (error) {
        console.warn('[huly] status check failed', error)
        set({
          hulyStatus: EMPTY_HULY_STATUS,
          hulyStatusChecked: true,
          hulyStatusChecking: false,
          hulyStatusContextKey: contextKey
        })
      }
    })()
    inflightHulyStatusChecks.set(contextKey, run)
    try {
      await run
    } finally {
      if (inflightHulyStatusChecks.get(contextKey) === run) {
        inflightHulyStatusChecks.delete(contextKey)
      }
    }
  },

  async refreshHulyPreflight() {
    try {
      const result = await hulyPreflight(hulyCallContext())
      set({ hulyPreflightStatus: result })
    } catch (error) {
      console.warn('[huly] preflight failed', error)
    }
  },

  async connectHuly(args) {
    try {
      const result = await hulyConnect(hulyCallContext(), args)
      if (!result.ok) {
        return result
      }
      await get().checkHulyConnection(true)
      await get().refreshHulyPreflight()
      const savedConnection = get().hulyStatus.connections.find((c) => c.name === args.name)
      const viewer = savedConnection ? (result.viewer ?? get().hulyStatus.viewer) : null
      if (!viewer) {
        return { ok: false, error: 'Connection saved but viewer not returned.' }
      }
      return { ok: true, viewer }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Connect failed' }
    }
  },

  async disconnectHuly(connectionId) {
    try {
      await hulyDisconnect(hulyCallContext(), connectionId)
    } finally {
      get().resetHulyCaches()
      await get().checkHulyConnection(true)
    }
  },

  async selectHulyConnection(connectionId) {
    try {
      await hulySelectConnection(hulyCallContext(), connectionId)
    } finally {
      get().resetHulyCaches()
      await get().checkHulyConnection(true)
    }
  },

  async fetchHulyIssue(id, connectionId, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId ?? connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${id}`
    const cached = get().hulyIssueCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const issue = await hulyGetIssue(hulyCallContext(options?.sourceContext), id, connId)
      if (issue) {
        set((state) => ({
          hulyIssueCache: evictStaleEntries({
            ...state.hulyIssueCache,
            [cacheKey]: { data: issue, fetchedAt: Date.now() }
          })
        }))
      }
      return issue
    } catch (error) {
      console.warn('[huly] getIssue failed', error)
      return null
    }
  },

  async listHulyIssues(args, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId ?? args.connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${args.filter ?? 'all'}::${args.limit ?? 50}`
    const cached = get().hulyListCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const issues = await hulyListIssues(
        hulyCallContext(options?.sourceContext),
        args.filter,
        args.limit,
        connId
      )
      set((state) => ({
        hulyListCache: evictStaleEntries({
          ...state.hulyListCache,
          [cacheKey]: { data: issues, fetchedAt: Date.now() }
        })
      }))
      return issues
    } catch (error) {
      console.warn('[huly] listIssues failed', error)
      return []
    }
  },

  async searchHulyIssues(query, limit, options) {
    try {
      return await hulySearchIssues(
        hulyCallContext(options?.sourceContext),
        query,
        limit,
        resolveConnectionId(options?.connectionId, get().hulyStatus)
      )
    } catch (error) {
      console.warn('[huly] searchIssues failed', error)
      return []
    }
  },

  async createHulyIssue(args, options) {
    try {
      const result = await hulyCreateIssue(hulyCallContext(options?.sourceContext), {
        ...args,
        connectionId:
          resolveConnectionId(options?.connectionId ?? args.connectionId, get().hulyStatus) ??
          undefined
      })
      if (result.ok) {
        get().invalidateHulyIssueLists({ sourceContext: options?.sourceContext })
      }
      return result
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Create issue failed'
      }
    }
  },

  async updateHulyIssue(id, updates, options) {
    try {
      const result = await hulyUpdateIssue(
        hulyCallContext(options?.sourceContext),
        id,
        updates,
        resolveConnectionId(options?.connectionId, get().hulyStatus)
      )
      if (result.ok) {
        const scope = hulyCacheScope(options?.sourceContext)
        set((state) => ({
          hulyIssueCache: pruneByPrefix(state.hulyIssueCache, `${scope}::`),
          hulyCommentCache: pruneByPrefix(state.hulyCommentCache, `${scope}::`)
        }))
        get().invalidateHulyIssueLists({ sourceContext: options?.sourceContext })
      }
      return result
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Update issue failed'
      }
    }
  },

  async addHulyComment(issueId, body, options) {
    try {
      const result = await hulyAddComment(
        hulyCallContext(options?.sourceContext),
        issueId,
        body,
        resolveConnectionId(options?.connectionId, get().hulyStatus)
      )
      if (result.ok) {
        const scope = hulyCacheScope(options?.sourceContext)
        set((state) => ({
          hulyCommentCache: pruneByPrefix(state.hulyCommentCache, `${scope}::`)
        }))
      }
      return result
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Add comment failed'
      }
    }
  },

  async listHulyComments(issueId, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${issueId}`
    const cached = get().hulyCommentCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const comments = await hulyListComments(
        hulyCallContext(options?.sourceContext),
        issueId,
        connId
      )
      set((state) => ({
        hulyCommentCache: evictStaleEntries({
          ...state.hulyCommentCache,
          [cacheKey]: { data: comments, fetchedAt: Date.now() }
        })
      }))
      return comments
    } catch (error) {
      console.warn('[huly] listComments failed', error)
      return []
    }
  },

  async listHulyTeams(connectionId, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId ?? connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}`
    const cached = get().hulyTeamCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const teams = await hulyListTeams(hulyCallContext(options?.sourceContext), connId)
      set((state) => ({
        hulyTeamCache: evictStaleEntries({
          ...state.hulyTeamCache,
          [cacheKey]: { data: teams, fetchedAt: Date.now() }
        })
      }))
      return teams
    } catch (error) {
      console.warn('[huly] listTeams failed', error)
      return []
    }
  },

  async listHulyTeamMembers(teamId, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${teamId}`
    const cached = get().hulyTeamMembersCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const members = await hulyTeamMembers(hulyCallContext(options?.sourceContext), teamId, connId)
      set((state) => ({
        hulyTeamMembersCache: evictStaleEntries({
          ...state.hulyTeamMembersCache,
          [cacheKey]: { data: members, fetchedAt: Date.now() }
        })
      }))
      return members
    } catch (error) {
      console.warn('[huly] teamMembers failed', error)
      return []
    }
  },

  async listHulyTeamStates(teamId, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${teamId}`
    const cached = get().hulyTeamStatesCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const states = await hulyTeamStates(hulyCallContext(options?.sourceContext), teamId, connId)
      set((state) => ({
        hulyTeamStatesCache: evictStaleEntries({
          ...state.hulyTeamStatesCache,
          [cacheKey]: { data: states, fetchedAt: Date.now() }
        })
      }))
      return states
    } catch (error) {
      console.warn('[huly] teamStates failed', error)
      return []
    }
  },

  async listHulyTeamLabels(teamId, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${teamId}`
    const cached = get().hulyTeamLabelsCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const labels = await hulyTeamLabels(hulyCallContext(options?.sourceContext), teamId, connId)
      set((state) => ({
        hulyTeamLabelsCache: evictStaleEntries({
          ...state.hulyTeamLabelsCache,
          [cacheKey]: { data: labels, fetchedAt: Date.now() }
        })
      }))
      return labels
    } catch (error) {
      console.warn('[huly] teamLabels failed', error)
      return []
    }
  },

  async listHulyProjects(query, limit, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${query ?? ''}::${limit ?? 50}`
    const cached = get().hulyProjectCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== null) {
      return cached.data
    }
    try {
      const projects = await hulyListProjects(
        hulyCallContext(options?.sourceContext),
        query,
        limit,
        connId
      )
      set((state) => ({
        hulyProjectCache: evictStaleEntries({
          ...state.hulyProjectCache,
          [cacheKey]: { data: projects, fetchedAt: Date.now() }
        })
      }))
      return projects
    } catch (error) {
      console.warn('[huly] listProjects failed', error)
      return []
    }
  },

  async fetchHulyProject(id, options) {
    const ctxKey = hulyCacheScope(options?.sourceContext)
    const connId = resolveConnectionId(options?.connectionId, get().hulyStatus)
    const cacheKey = `${ctxKey}::${connId ?? ''}::${id}`
    const cached = get().hulyProjectDetailCache[cacheKey]
    if (!options?.force && isFresh(cached) && cached.data !== undefined) {
      return cached.data
    }
    try {
      const project = await hulyGetProject(hulyCallContext(options?.sourceContext), id, connId)
      set((state) => ({
        hulyProjectDetailCache: evictStaleEntries({
          ...state.hulyProjectDetailCache,
          [cacheKey]: { data: project, fetchedAt: Date.now() }
        })
      }))
      return project
    } catch (error) {
      console.warn('[huly] getProject failed', error)
      return null
    }
  },

  async createHulyProject(args, options) {
    try {
      const result = await hulyCreateProject(hulyCallContext(options?.sourceContext), {
        ...args,
        connectionId:
          resolveConnectionId(options?.connectionId ?? args.connectionId, get().hulyStatus) ??
          undefined
      })
      if (result.ok) {
        const scope = hulyCacheScope(options?.sourceContext)
        set((state) => ({
          hulyProjectCache: pruneByPrefix(state.hulyProjectCache, `${scope}::`),
          hulyProjectDetailCache: pruneByPrefix(state.hulyProjectDetailCache, `${scope}::`)
        }))
      }
      return result
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Create project failed'
      }
    }
  },

  async listHulyProjectIssues(projectId, options) {
    try {
      return await hulyListProjectIssues(
        hulyCallContext(options?.sourceContext),
        projectId,
        undefined,
        resolveConnectionId(options?.connectionId, get().hulyStatus)
      )
    } catch (error) {
      console.warn('[huly] listProjectIssues failed', error)
      return []
    }
  },

  invalidateHulyIssueLists(options) {
    const scope = options?.sourceContext ? hulyCacheScope(options.sourceContext) : ''
    const previous = get().hulyListInvalidationToken
    set({
      hulyListInvalidationToken: { scope, version: previous.version + 1 },
      hulyListCache: scope ? pruneByPrefix(get().hulyListCache, `${scope}::`) : {}
    })
  },

  resetHulyCaches() {
    set({
      hulyIssueCache: {},
      hulyListCache: {},
      hulyTeamCache: {},
      hulyProjectCache: {},
      hulyProjectDetailCache: {},
      hulyCommentCache: {},
      hulyTeamMembersCache: {},
      hulyTeamStatesCache: {},
      hulyTeamLabelsCache: {}
    })
  }
})
