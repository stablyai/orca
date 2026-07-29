/* eslint-disable max-lines -- Why: the Linear slice owns status, workspace
   selection, issue caches, and optimistic patch propagation as one store
   boundary so cache invalidation stays coherent. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  LinearViewer,
  LinearConnectionStatus,
  LinearCollectionResult,
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearIssue,
  LinearProjectDetail,
  LinearProjectSummary,
  LinearTeam,
  LinearWorkspace,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../../../shared/types'
import type { CacheEntry } from './github'
import { clampLinearIssueListLimit } from '../../../../shared/linear-issue-read-limits'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import { clearLinearMetadataCache } from '../../hooks/useIssueMetadata'
import {
  isLinearIssueAttributeFilterUnsupportedError,
  linearConnect,
  linearDisconnect,
  linearDisconnectWorkspace,
  linearGetCustomView,
  linearGetProject,
  linearGetIssue,
  linearListCustomViewIssues,
  linearListCustomViewProjects,
  linearListCustomViews,
  linearListIssues,
  linearListProjectIssues,
  linearListProjects,
  linearListTeams,
  linearSearchIssues,
  linearSelectWorkspace,
  linearStatus,
  linearTestConnection
} from '@/runtime/runtime-linear-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import {
  canonicalizeLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  linearIssueAttributeFilterSignature,
  type LinearIssueAttributeFilter
} from '../../../../shared/linear-issue-attribute-filter'

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
  contextKey: string
  mutationGeneration: number
}

function workspaceErrorType(error: unknown): LinearWorkspaceError['type'] {
  const record = error as { name?: string; message?: string; status?: number; response?: unknown }
  const message = record.message ?? String(error)
  const status =
    typeof record.status === 'number'
      ? record.status
      : typeof (record.response as { status?: unknown } | undefined)?.status === 'number'
        ? ((record.response as { status: number }).status as number)
        : undefined
  if (looksLikeAuthError(error)) {
    return 'auth'
  }
  if (status === 429 || /rate/i.test(record.name ?? '')) {
    return 'rate_limited'
  }
  if ((typeof status === 'number' && status >= 500) || /network/i.test(record.name ?? message)) {
    return 'network'
  }
  return 'unknown'
}

function workspaceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const inflightIssueRequests = new Map<string, InflightLinearIssueRequest>()
type InflightLinearListRequest = {
  promise: Promise<LinearIssue[]>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}
type InflightLinearPlainListRequest = {
  promise: Promise<LinearCollectionResult<LinearIssue>>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}
type InflightLinearCollectionRequest<T> = {
  promise: Promise<LinearCollectionResult<T>>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}
type InflightLinearDetailRequest<T> = {
  promise: Promise<T>
  force: boolean
  contextKey: string
  mutationGeneration: number
}

const inflightSearchRequests = new Map<string, InflightLinearListRequest>()
const inflightListRequests = new Map<string, InflightLinearPlainListRequest>()
type InflightLinearTeamRequest = {
  promise: Promise<LinearTeam[]>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}

const inflightTeamRequests = new Map<string, InflightLinearTeamRequest>()
const inflightProjectRequests = new Map<
  string,
  InflightLinearCollectionRequest<LinearProjectSummary>
>()
const inflightProjectDetailRequests = new Map<
  string,
  InflightLinearDetailRequest<LinearProjectDetail | null>
>()
const inflightProjectIssueRequests = new Map<string, InflightLinearCollectionRequest<LinearIssue>>()
const inflightCustomViewRequests = new Map<
  string,
  InflightLinearCollectionRequest<LinearCustomViewSummary>
>()
const inflightCustomViewDetailRequests = new Map<
  string,
  InflightLinearDetailRequest<LinearCustomViewSummary | null>
>()
const inflightCustomViewIssueRequests = new Map<
  string,
  InflightLinearCollectionRequest<LinearIssue>
>()
const inflightCustomViewProjectRequests = new Map<
  string,
  InflightLinearCollectionRequest<LinearProjectSummary>
>()
let inflightStatusRequest: { contextKey: string; promise: Promise<void> } | null = null
let linearStatusReadGeneration = 0
let linearMutationGeneration = 0
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
  limit: number,
  attributeFilter?: LinearIssueAttributeFilter | null
): string {
  const attributeSignature = linearIssueAttributeFilterSignature(attributeFilter)
  return `${workspaceId ?? 'default'}::list::${filter}::${limit}::${attributeSignature}`
}

// Why: facet mutations need one source-scoped token TaskPage can observe without
// scattering membership guesses through board/detail components.
const LINEAR_LIST_INVALIDATION_VERSION_CAP = 10_000
let linearListInvalidationToken: { scope: string; version: number } = {
  scope: '',
  version: 0
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
    credentialError: status.credentialError ?? null,
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
  inflightProjectRequests.clear()
  inflightProjectDetailRequests.clear()
  inflightProjectIssueRequests.clear()
  inflightCustomViewRequests.clear()
  inflightCustomViewDetailRequests.clear()
  inflightCustomViewIssueRequests.clear()
  inflightCustomViewProjectRequests.clear()
}

function invalidateLinearCaches(): void {
  linearCacheGeneration += 1
  clearLinearRequestMaps()
  clearLinearMetadataCache()
}

function clearLinearIssueCollectionRequestMaps(): void {
  inflightSearchRequests.clear()
  inflightListRequests.clear()
  inflightProjectIssueRequests.clear()
  inflightCustomViewIssueRequests.clear()
}

function shouldRefreshStatusAfterRead(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  status: LinearConnectionStatus
): boolean {
  // Why: 'all' reads can hide per-workspace decrypt failures, and a visible
  // credential error may have been cleared by a successful credential read.
  return workspaceId === 'all' || status.credentialError !== undefined
}

function linearCollectionCacheKey(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  mode: string,
  ...parts: (string | number | null | undefined)[]
): string {
  return [workspaceId ?? 'default', mode, ...parts.map((part) => part ?? '')].join('::')
}

function emptyLinearCollection<T>(): LinearCollectionResult<T> {
  return { items: [] }
}

function collectionWithWorkspaceError<T>(
  fallback: LinearCollectionResult<T>,
  workspaceId: string,
  error: unknown
): LinearCollectionResult<T> {
  const existingErrors = (fallback.errors ?? []).filter((item) => item.workspaceId !== workspaceId)
  return {
    ...fallback,
    errors: [
      ...existingErrors,
      {
        workspaceId,
        type: workspaceErrorType(error),
        message: workspaceErrorMessage(error) || 'Linear request failed.'
      }
    ]
  }
}

function largestCachedCollectionBelowLimit<T>(
  cache: Record<string, CacheEntry<LinearCollectionResult<T>>>,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  mode: string,
  scopeId: string,
  limit: number
): LinearCollectionResult<T> | null {
  const keyPrefix = `${linearCollectionCacheKey(workspaceId, mode, scopeId)}::`
  let best: { limit: number; data: LinearCollectionResult<T> } | null = null
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry?.data || !key.startsWith(keyPrefix)) {
      continue
    }
    const cachedLimit = Number(key.slice(keyPrefix.length))
    if (!Number.isFinite(cachedLimit) || cachedLimit >= limit) {
      continue
    }
    if (!best || cachedLimit > best.limit) {
      best = { limit: cachedLimit, data: entry.data }
    }
  }
  return best?.data ?? null
}

function patchLinearIssueCollectionCache(
  cache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>,
  issueId: string,
  patch: Partial<LinearIssue>,
  canPatchCacheKey: (key: string) => boolean
): {
  cache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  changed: boolean
} {
  let changed = false
  const nextCache = { ...cache }
  for (const [key, entry] of Object.entries(nextCache)) {
    if (!canPatchCacheKey(key) || !entry?.data) {
      continue
    }
    const idx = entry.data.items.findIndex((item) => item.id === issueId)
    if (idx === -1) {
      continue
    }
    const updatedItems = [...entry.data.items]
    updatedItems[idx] = { ...updatedItems[idx], ...patch }
    nextCache[key] = {
      ...entry,
      data: { ...entry.data, items: updatedItems }
    }
    changed = true
  }
  return { cache: nextCache, changed }
}

export type LinearIssueListReadArgs = {
  kind: 'list'
  filter?: 'assigned' | 'created' | 'all' | 'completed'
  limit?: number
  attributeFilter?: LinearIssueAttributeFilter | null
}

export type LinearIssueReadArgs =
  | { kind: 'search'; query: string; limit?: number }
  | LinearIssueListReadArgs

type LinearFetchOptions = { force?: boolean; sourceContext?: TaskSourceContext | null }
type LinearPatchOptions = { sourceContext?: TaskSourceContext | null }

function normalizeListAttributeFilter(
  attributeFilter?: LinearIssueAttributeFilter | null
): LinearIssueAttributeFilter | undefined {
  if (!attributeFilter || isEmptyLinearIssueAttributeFilter(attributeFilter)) {
    return undefined
  }
  return canonicalizeLinearIssueAttributeFilter(attributeFilter)
}

type LinearReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

function beginLinearMutation(): number {
  linearMutationGeneration += 1
  inflightStatusRequest = null
  return linearMutationGeneration
}

function isCurrentLinearMutation(generation: number): boolean {
  return generation === linearMutationGeneration
}

function isCurrentLinearRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

function canWriteLinearReadResult(
  contextKey: string,
  generation: number,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    generation === linearCacheGeneration &&
    mutationGeneration === linearMutationGeneration &&
    (explicitSource || isCurrentLinearRuntimeContext(contextKey, settings))
  )
}

function getLinearReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): LinearReadScope {
  if (!sourceContext) {
    return {
      settings,
      contextKey: getProviderRuntimeContextKey(settings),
      cachePrefix: null,
      explicitSource: false
    }
  }
  const runtimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  return {
    settings: sourceContext,
    contextKey: `${getProviderRuntimeContextKey(runtimeSettings)}::${getTaskSourceCacheScope(sourceContext)}`,
    cachePrefix: getTaskSourceCacheScope(sourceContext),
    explicitSource: true
  }
}

function scopedLinearCacheKey(scope: LinearReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

export type LinearSlice = {
  linearStatus: LinearConnectionStatus
  linearStatusChecked: boolean
  linearStatusContextKey: string | null
  linearIssueCache: Record<string, CacheEntry<LinearIssue>>
  linearSearchCache: Record<string, CacheEntry<LinearIssue[]>>
  linearListCache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  linearTeamCache: Record<string, CacheEntry<LinearTeam[]>>
  linearProjectCache: Record<string, CacheEntry<LinearCollectionResult<LinearProjectSummary>>>
  linearProjectDetailCache: Record<string, CacheEntry<LinearProjectDetail | null>>
  linearProjectIssueCache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  linearCustomViewCache: Record<string, CacheEntry<LinearCollectionResult<LinearCustomViewSummary>>>
  linearCustomViewDetailCache: Record<string, CacheEntry<LinearCustomViewSummary | null>>
  linearCustomViewIssueCache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  linearCustomViewProjectCache: Record<
    string,
    CacheEntry<LinearCollectionResult<LinearProjectSummary>>
  >

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
  fetchLinearIssue: (
    id: string,
    workspaceId?: string | null,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue | null>
  refreshLinearIssue: (
    id: string,
    workspaceId?: string | null,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue | null>
  getCachedLinearIssues: (
    args: LinearIssueReadArgs,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearIssue[] | LinearCollectionResult<LinearIssue> | null
  prefetchLinearIssues: (args: LinearIssueReadArgs, options?: LinearFetchOptions) => void
  searchLinearIssues: (
    query: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue[]>
  listLinearIssues: (
    args: LinearIssueListReadArgs,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearIssue>>
  linearListInvalidationToken: { scope: string; version: number }
  invalidateLinearIssueLists: (options?: Pick<LinearFetchOptions, 'sourceContext'>) => void
  getCachedLinearTeams: (
    workspaceId?: LinearWorkspaceSelection | null,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearTeam[] | null
  listLinearTeams: (
    workspaceId?: LinearWorkspaceSelection | null,
    options?: LinearFetchOptions
  ) => Promise<LinearTeam[]>
  getCachedLinearProjects: (
    query?: string,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearCollectionResult<LinearProjectSummary> | null
  listLinearProjects: (
    query?: string,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearProjectSummary>>
  fetchLinearProject: (
    id: string,
    workspaceId: string,
    options?: LinearFetchOptions
  ) => Promise<LinearProjectDetail | null>
  listLinearProjectIssues: (
    projectId: string,
    workspaceId: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearIssue>>
  getCachedLinearCustomViews: (
    model: LinearCustomViewModel,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearCollectionResult<LinearCustomViewSummary> | null
  listLinearCustomViews: (
    model: LinearCustomViewModel,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearCustomViewSummary>>
  fetchLinearCustomView: (
    viewId: string,
    workspaceId: string,
    model: LinearCustomViewModel,
    options?: LinearFetchOptions
  ) => Promise<LinearCustomViewSummary | null>
  listLinearCustomViewIssues: (
    viewId: string,
    workspaceId: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearIssue>>
  listLinearCustomViewProjects: (
    viewId: string,
    workspaceId: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearProjectSummary>>
  patchLinearIssue: (
    issueId: string,
    patch: Partial<LinearIssue>,
    options?: LinearPatchOptions
  ) => void
}

export const createLinearSlice: StateCreator<AppState, [], [], LinearSlice> = (set, get) => ({
  linearStatus: { connected: false, viewer: null },
  linearStatusChecked: false,
  linearStatusContextKey: null,
  linearIssueCache: {},
  linearSearchCache: {},
  linearListCache: {},
  linearTeamCache: {},
  linearProjectCache: {},
  linearProjectDetailCache: {},
  linearProjectIssueCache: {},
  linearCustomViewCache: {},
  linearCustomViewDetailCache: {},
  linearCustomViewIssueCache: {},
  linearCustomViewProjectCache: {},
  linearListInvalidationToken: linearListInvalidationToken,

  checkLinearConnection: async (force = false) => {
    const contextKey = getProviderRuntimeContextKey(get().settings)
    if (inflightStatusRequest && !force && inflightStatusRequest.contextKey === contextKey) {
      return inflightStatusRequest.promise
    }
    if (get().linearStatusContextKey !== contextKey) {
      set({ linearStatusChecked: false })
    }

    const mutationGeneration = linearMutationGeneration
    const statusReadGeneration = (linearStatusReadGeneration += 1)
    const request = linearStatus(get().settings)
      .then((status) => {
        if (
          mutationGeneration !== linearMutationGeneration ||
          statusReadGeneration !== linearStatusReadGeneration ||
          !isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
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
            linearListCache: {},
            linearTeamCache: {},
            linearProjectCache: {},
            linearProjectDetailCache: {},
            linearProjectIssueCache: {},
            linearCustomViewCache: {},
            linearCustomViewDetailCache: {},
            linearCustomViewIssueCache: {},
            linearCustomViewProjectCache: {},
            linearStatusChecked: true,
            linearStatusContextKey: contextKey
          })
        } else if (!get().linearStatusChecked) {
          set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
        } else if (get().linearStatusContextKey !== contextKey) {
          set({ linearStatusContextKey: contextKey })
        }
      })
      .catch(() => {
        if (
          mutationGeneration !== linearMutationGeneration ||
          statusReadGeneration !== linearStatusReadGeneration ||
          !isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          return
        }
        if (get().linearStatus.connected) {
          invalidateLinearCaches()
          set({
            linearStatus: { connected: false, viewer: null },
            linearIssueCache: {},
            linearSearchCache: {},
            linearListCache: {},
            linearTeamCache: {},
            linearProjectCache: {},
            linearProjectDetailCache: {},
            linearProjectIssueCache: {},
            linearCustomViewCache: {},
            linearCustomViewDetailCache: {},
            linearCustomViewIssueCache: {},
            linearCustomViewProjectCache: {},
            linearStatusChecked: true,
            linearStatusContextKey: contextKey
          })
        } else if (!get().linearStatusChecked) {
          set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
        } else if (get().linearStatusContextKey !== contextKey) {
          set({ linearStatusContextKey: contextKey })
        }
      })
      .finally(() => {
        if (
          statusReadGeneration === linearStatusReadGeneration &&
          inflightStatusRequest?.promise === request
        ) {
          inflightStatusRequest = null
        }
      })
    inflightStatusRequest = { contextKey, promise: request }

    return request
  },

  testLinearConnection: async (workspaceId) => {
    const requestGeneration = beginLinearMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = (await linearTestConnection(get().settings, workspaceId)) as
        | { ok: true; viewer: LinearViewer }
        | { ok: false; error: string }
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return result
      }
      const status = await linearStatus(get().settings)
      if (
        isCurrentLinearMutation(requestGeneration) &&
        isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        const prev = get().linearStatus
        if (linearStatusScopeSignature(prev) !== linearStatusScopeSignature(status)) {
          invalidateLinearCaches()
          set({
            linearStatus: status,
            linearIssueCache: {},
            linearSearchCache: {},
            linearListCache: {},
            linearTeamCache: {},
            linearProjectCache: {},
            linearProjectDetailCache: {},
            linearProjectIssueCache: {},
            linearCustomViewCache: {},
            linearCustomViewDetailCache: {},
            linearCustomViewIssueCache: {},
            linearCustomViewProjectCache: {},
            linearStatusChecked: true,
            linearStatusContextKey: contextKey
          })
        } else {
          set({
            linearStatus: status,
            linearStatusChecked: true,
            linearStatusContextKey: contextKey
          })
        }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  connectLinear: async (apiKey: string) => {
    const requestGeneration = beginLinearMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = await linearConnect(get().settings, apiKey)
      if (
        result.ok &&
        isCurrentLinearMutation(requestGeneration) &&
        isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        invalidateLinearCaches()
        set({
          linearIssueCache: {},
          linearSearchCache: {},
          linearListCache: {},
          linearTeamCache: {},
          linearProjectCache: {},
          linearProjectDetailCache: {},
          linearProjectIssueCache: {},
          linearCustomViewCache: {},
          linearCustomViewDetailCache: {},
          linearCustomViewIssueCache: {},
          linearCustomViewProjectCache: {}
        })
        const status = await linearStatus(get().settings)
        if (
          !isCurrentLinearMutation(requestGeneration) ||
          !isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.linear.37d36984d0',
              'Linear connection was superseded by a newer request.'
            )
          }
        }
        set({
          linearStatus: status,
          linearStatusChecked: true,
          linearStatusContextKey: contextKey
        })
      } else if (result.ok) {
        return {
          ok: false as const,
          error: translate(
            'auto.store.slices.linear.37d36984d0',
            'Linear connection was superseded by a newer request.'
          )
        }
      }
      return result as { ok: true; viewer: LinearViewer } | { ok: false; error: string }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  selectLinearWorkspace: async (workspaceId) => {
    const requestGeneration = beginLinearMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const status = await linearSelectWorkspace(get().settings, workspaceId)
    if (
      !isCurrentLinearMutation(requestGeneration) ||
      !isCurrentLinearRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    invalidateLinearCaches()
    set({
      linearStatus: status,
      linearIssueCache: {},
      linearSearchCache: {},
      linearListCache: {},
      linearTeamCache: {},
      linearProjectCache: {},
      linearProjectDetailCache: {},
      linearProjectIssueCache: {},
      linearCustomViewCache: {},
      linearCustomViewDetailCache: {},
      linearCustomViewIssueCache: {},
      linearCustomViewProjectCache: {},
      linearStatusChecked: true,
      linearStatusContextKey: contextKey
    })
  },

  disconnectLinear: async () => {
    const requestGeneration = beginLinearMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    await linearDisconnect(get().settings)
    if (
      !isCurrentLinearMutation(requestGeneration) ||
      !isCurrentLinearRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    invalidateLinearCaches()
    set({
      linearStatus: { connected: false, viewer: null },
      linearIssueCache: {},
      linearSearchCache: {},
      linearListCache: {},
      linearTeamCache: {},
      linearProjectCache: {},
      linearProjectDetailCache: {},
      linearProjectIssueCache: {},
      linearCustomViewCache: {},
      linearCustomViewDetailCache: {},
      linearCustomViewIssueCache: {},
      linearCustomViewProjectCache: {},
      linearStatusChecked: true,
      linearStatusContextKey: contextKey
    })
  },

  disconnectLinearWorkspace: async (workspaceId) => {
    const requestGeneration = beginLinearMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    await linearDisconnectWorkspace(get().settings, workspaceId)
    if (
      !isCurrentLinearMutation(requestGeneration) ||
      !isCurrentLinearRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    const status = await linearStatus(get().settings)
    if (
      !isCurrentLinearMutation(requestGeneration) ||
      !isCurrentLinearRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    invalidateLinearCaches()
    set({
      linearStatus: status,
      linearIssueCache: {},
      linearSearchCache: {},
      linearListCache: {},
      linearTeamCache: {},
      linearProjectCache: {},
      linearProjectDetailCache: {},
      linearProjectIssueCache: {},
      linearCustomViewCache: {},
      linearCustomViewDetailCache: {},
      linearCustomViewIssueCache: {},
      linearCustomViewProjectCache: {},
      linearStatusChecked: true,
      linearStatusContextKey: contextKey
    })
  },

  fetchLinearIssue: async (
    id: string,
    workspaceId?: string | null,
    options?: LinearFetchOptions
  ) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const issueCacheKey = scopedLinearCacheKey(scope, `${workspaceId ?? 'selected'}::${id}`)
    const cached = get().linearIssueCache[issueCacheKey] ?? get().linearIssueCache[id]
    if (isFresh(cached)) {
      return cached.data
    }

    const inflight = inflightIssueRequests.get(issueCacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration
    ) {
      return inflight.promise
    }

    let entry: InflightLinearIssueRequest
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearGetIssue(scope.settings, id, workspaceId)
      .then((issue) => {
        const data = issue as LinearIssue | null
        if (
          inflightIssueRequests.get(issueCacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
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
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        return null
      })
      .finally(() => {
        if (inflightIssueRequests.get(issueCacheKey) === entry) {
          inflightIssueRequests.delete(issueCacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightIssueRequests.set(issueCacheKey, entry)
    return promise
  },

  refreshLinearIssue: async (
    id: string,
    workspaceId?: string | null,
    options?: LinearFetchOptions
  ) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const issueCacheKey = scopedLinearCacheKey(scope, `${workspaceId ?? 'selected'}::${id}`)
    inflightIssueRequests.delete(issueCacheKey)
    clearLinearIssueCollectionRequestMaps()
    set((s) => {
      const nextIssueCache = { ...s.linearIssueCache }
      for (const [key, entry] of Object.entries(nextIssueCache)) {
        if (
          key === issueCacheKey ||
          key === id ||
          entry?.data?.id === id ||
          entry?.data?.identifier === id
        ) {
          delete nextIssueCache[key]
        }
      }
      return {
        linearIssueCache: nextIssueCache,
        linearSearchCache: {},
        linearListCache: {},
        linearProjectIssueCache: {},
        linearCustomViewIssueCache: {}
      }
    })
    return get().fetchLinearIssue(id, workspaceId, options)
  },

  getCachedLinearIssues: (args, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    if (args.kind === 'search') {
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearSearchCacheKey(workspaceId, args.query, args.limit ?? 20)
      )
      return get().linearSearchCache[cacheKey]?.data ?? null
    }
    const limit = clampLinearIssueListLimit(args.limit)
    const attributeFilter = normalizeListAttributeFilter(args.attributeFilter)
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearListCacheKey(workspaceId, args.filter ?? 'assigned', limit, attributeFilter)
    )
    return get().linearListCache[cacheKey]?.data ?? null
  },

  prefetchLinearIssues: (args, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    if (args.kind === 'search') {
      const limit = args.limit ?? 20
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearSearchCacheKey(workspaceId, args.query, limit)
      )
      const inflight = inflightSearchRequests.get(cacheKey)
      if (
        isFresh(get().linearSearchCache[cacheKey]) ||
        (inflight &&
          inflight.contextKey === contextKey &&
          inflight.mutationGeneration === linearMutationGeneration)
      ) {
        return
      }
      void get()
        .searchLinearIssues(args.query, limit, options)
        .catch(() => {})
      return
    }
    const limit = clampLinearIssueListLimit(args.limit)
    const attributeFilter = normalizeListAttributeFilter(args.attributeFilter)
    const listArgs: LinearIssueListReadArgs = {
      kind: 'list',
      filter: args.filter,
      limit,
      attributeFilter
    }
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearListCacheKey(workspaceId, args.filter ?? 'assigned', limit, attributeFilter)
    )
    const inflight = inflightListRequests.get(cacheKey)
    if (
      isFresh(get().linearListCache[cacheKey]) ||
      (inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === linearMutationGeneration)
    ) {
      return
    }
    void get()
      .listLinearIssues(listArgs, options)
      .catch(() => {})
  },

  searchLinearIssues: async (query: string, limit = 20, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = scopedLinearCacheKey(scope, linearSearchCacheKey(workspaceId, query, limit))
    const cached = get().linearSearchCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }

    const inflight = inflightSearchRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearListRequest
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearSearchIssues(scope.settings, query, limit, workspaceId)
      .then((issues) => {
        const data = issues as LinearIssue[]
        if (
          inflightSearchRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
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
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          if (!shouldRefreshStatusAfterRead(workspaceId, get().linearStatus)) {
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
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightSearchRequests.set(cacheKey, entry)
    return promise
  },

  listLinearIssues: async (args, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const workspaceId = getSelectedWorkspaceId(get().linearStatus)
    const filter = args.filter ?? 'assigned'
    const effectiveLimit = clampLinearIssueListLimit(args.limit)
    const attributeFilter = normalizeListAttributeFilter(args.attributeFilter)
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearListCacheKey(workspaceId, filter, effectiveLimit, attributeFilter)
    )
    const cached = get().linearListCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? emptyLinearCollection<LinearIssue>()
    }

    const inflight = inflightListRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearPlainListRequest
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise: Promise<LinearCollectionResult<LinearIssue>> = linearListIssues(
      scope.settings,
      filter,
      effectiveLimit,
      workspaceId,
      attributeFilter
    )
      .then((result) => {
        const data = result as LinearCollectionResult<LinearIssue>
        if (
          inflightListRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearListCache: evictStaleEntries({
              ...s.linearListCache,
              [cacheKey]: { data, fetchedAt: Date.now() }
            })
          }))
        }
        return data
      })
      .catch((error) => {
        console.warn('[linear] listLinearIssues failed:', error)
        // Why: capability mismatch is actionable (update remote runtime). Swallowing
        // it as [] would look like "no issues match filters" and hide the fix.
        if (isLinearIssueAttributeFilterUnsupportedError(error)) {
          throw error
        }
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          if (!shouldRefreshStatusAfterRead(workspaceId, get().linearStatus)) {
            void get().checkLinearConnection(true)
          }
          return emptyLinearCollection<LinearIssue>()
        }
        return get().linearListCache[cacheKey]?.data ?? emptyLinearCollection<LinearIssue>()
      })
      .finally(() => {
        if (inflightListRequests.get(cacheKey) === entry) {
          inflightListRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightListRequests.set(cacheKey, entry)
    return promise
  },

  getCachedLinearTeams: (workspaceId, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const key = linearTeamsCacheKey(workspaceId ?? getSelectedWorkspaceId(get().linearStatus))
    return get().linearTeamCache[scopedLinearCacheKey(scope, key)]?.data ?? null
  },

  listLinearTeams: async (workspaceId, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = scopedLinearCacheKey(scope, linearTeamsCacheKey(resolvedWorkspaceId))
    const cached = get().linearTeamCache[cacheKey]
    if (!options?.force && isFresh(cached, TEAM_CACHE_TTL)) {
      return cached.data ?? []
    }

    const inflight = inflightTeamRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearTeamRequest
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearListTeams(scope.settings, resolvedWorkspaceId)
      .then((teams) => {
        const data = teams as LinearTeam[]
        if (
          inflightTeamRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
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
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          if (!shouldRefreshStatusAfterRead(resolvedWorkspaceId, get().linearStatus)) {
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
          shouldRefreshStatusAfterRead(resolvedWorkspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightTeamRequests.set(cacheKey, entry)
    return promise
  },

  getCachedLinearProjects: (query, limit = 20, workspaceId, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = linearCollectionCacheKey(resolvedWorkspaceId, 'projects', query?.trim(), limit)
    return get().linearProjectCache[scopedLinearCacheKey(scope, cacheKey)]?.data ?? null
  },

  listLinearProjects: async (query, limit = 20, workspaceId, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
    const trimmed = query?.trim() || undefined
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(resolvedWorkspaceId, 'projects', trimmed, limit)
    )
    const cached = get().linearProjectCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? emptyLinearCollection<LinearProjectSummary>()
    }

    const inflight = inflightProjectRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearCollectionRequest<LinearProjectSummary>
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearListProjects(scope.settings, trimmed, limit, resolvedWorkspaceId, {
      force: options?.force
    })
      .then((result) => {
        if (
          inflightProjectRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearProjectCache: evictStaleEntries({
              ...s.linearProjectCache,
              [cacheKey]: { data: result, fetchedAt: Date.now() }
            })
          }))
        }
        return result
      })
      .catch((error) => {
        console.warn('[linear] listLinearProjects failed:', error)
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        const fallback =
          get().linearProjectCache[cacheKey]?.data ?? emptyLinearCollection<LinearProjectSummary>()
        return collectionWithWorkspaceError(fallback, resolvedWorkspaceId ?? 'default', error)
      })
      .finally(() => {
        if (inflightProjectRequests.get(cacheKey) === entry) {
          inflightProjectRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(resolvedWorkspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightProjectRequests.set(cacheKey, entry)
    return promise
  },

  fetchLinearProject: async (id, workspaceId, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(workspaceId, 'project-detail', id)
    )
    const cached = get().linearProjectDetailCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data
    }

    const inflight = inflightProjectDetailRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearDetailRequest<LinearProjectDetail | null>
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearGetProject(scope.settings, id, workspaceId, {
      force: options?.force
    })
      .then((project) => {
        if (
          inflightProjectDetailRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearProjectDetailCache: evictStaleEntries({
              ...s.linearProjectDetailCache,
              [cacheKey]: { data: project, fetchedAt: Date.now() }
            })
          }))
        }
        return project
      })
      .catch((error) => {
        console.warn('[linear] fetchLinearProject failed:', error)
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        if (options?.force) {
          throw error
        }
        const cachedResult = get().linearProjectDetailCache[cacheKey]
        if (cachedResult) {
          return cachedResult.data
        }
        throw error
      })
      .finally(() => {
        if (inflightProjectDetailRequests.get(cacheKey) === entry) {
          inflightProjectDetailRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightProjectDetailRequests.set(cacheKey, entry)
    return promise
  },

  listLinearProjectIssues: async (projectId, workspaceId, limit = 20, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const effectiveLimit = clampLinearIssueListLimit(limit)
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(workspaceId, 'project-issues', projectId, effectiveLimit)
    )
    const cached = get().linearProjectIssueCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? emptyLinearCollection<LinearIssue>()
    }

    const inflight = inflightProjectIssueRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearCollectionRequest<LinearIssue>
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearListProjectIssues(
      scope.settings,
      projectId,
      effectiveLimit,
      workspaceId,
      {
        force: options?.force
      }
    )
      .then((result) => {
        if (
          inflightProjectIssueRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearProjectIssueCache: evictStaleEntries({
              ...s.linearProjectIssueCache,
              [cacheKey]: { data: result, fetchedAt: Date.now() }
            })
          }))
        }
        return result
      })
      .catch((error) => {
        console.warn('[linear] listLinearProjectIssues failed:', error)
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        const fallback =
          get().linearProjectIssueCache[cacheKey]?.data ??
          largestCachedCollectionBelowLimit(
            get().linearProjectIssueCache,
            workspaceId,
            'project-issues',
            projectId,
            effectiveLimit
          ) ??
          emptyLinearCollection<LinearIssue>()
        return collectionWithWorkspaceError(fallback, workspaceId, error)
      })
      .finally(() => {
        if (inflightProjectIssueRequests.get(cacheKey) === entry) {
          inflightProjectIssueRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightProjectIssueRequests.set(cacheKey, entry)
    return promise
  },

  getCachedLinearCustomViews: (model, limit = 20, workspaceId, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = linearCollectionCacheKey(resolvedWorkspaceId, 'custom-views', model, limit)
    return get().linearCustomViewCache[scopedLinearCacheKey(scope, cacheKey)]?.data ?? null
  },

  listLinearCustomViews: async (model, limit = 20, workspaceId, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(resolvedWorkspaceId, 'custom-views', model, limit)
    )
    const cached = get().linearCustomViewCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? emptyLinearCollection<LinearCustomViewSummary>()
    }

    const inflight = inflightCustomViewRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearCollectionRequest<LinearCustomViewSummary>
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearListCustomViews(scope.settings, model, limit, resolvedWorkspaceId, {
      force: options?.force
    })
      .then((result) => {
        if (
          inflightCustomViewRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearCustomViewCache: evictStaleEntries({
              ...s.linearCustomViewCache,
              [cacheKey]: { data: result, fetchedAt: Date.now() }
            })
          }))
        }
        return result
      })
      .catch((error) => {
        console.warn('[linear] listLinearCustomViews failed:', error)
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        const fallback =
          get().linearCustomViewCache[cacheKey]?.data ??
          emptyLinearCollection<LinearCustomViewSummary>()
        return collectionWithWorkspaceError(fallback, resolvedWorkspaceId ?? 'default', error)
      })
      .finally(() => {
        if (inflightCustomViewRequests.get(cacheKey) === entry) {
          inflightCustomViewRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(resolvedWorkspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightCustomViewRequests.set(cacheKey, entry)
    return promise
  },

  fetchLinearCustomView: async (viewId, workspaceId, model, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(workspaceId, 'custom-view-detail', model, viewId)
    )
    const cached = get().linearCustomViewDetailCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data
    }

    const inflight = inflightCustomViewDetailRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearDetailRequest<LinearCustomViewSummary | null>
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearGetCustomView(scope.settings, viewId, model, workspaceId, {
      force: options?.force
    })
      .then((view) => {
        if (
          inflightCustomViewDetailRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearCustomViewDetailCache: evictStaleEntries({
              ...s.linearCustomViewDetailCache,
              [cacheKey]: { data: view, fetchedAt: Date.now() }
            })
          }))
        }
        return view
      })
      .catch((error) => {
        console.warn('[linear] fetchLinearCustomView failed:', error)
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        if (options?.force) {
          throw error
        }
        const cachedResult = get().linearCustomViewDetailCache[cacheKey]
        if (cachedResult) {
          return cachedResult.data
        }
        throw error
      })
      .finally(() => {
        if (inflightCustomViewDetailRequests.get(cacheKey) === entry) {
          inflightCustomViewDetailRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightCustomViewDetailRequests.set(cacheKey, entry)
    return promise
  },

  listLinearCustomViewIssues: async (viewId, workspaceId, limit = 20, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const effectiveLimit = clampLinearIssueListLimit(limit)
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(workspaceId, 'custom-view-issues', viewId, effectiveLimit)
    )
    const cached = get().linearCustomViewIssueCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? emptyLinearCollection<LinearIssue>()
    }

    const inflight = inflightCustomViewIssueRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearCollectionRequest<LinearIssue>
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearListCustomViewIssues(
      scope.settings,
      viewId,
      effectiveLimit,
      workspaceId,
      {
        force: options?.force
      }
    )
      .then((result) => {
        if (
          inflightCustomViewIssueRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearCustomViewIssueCache: evictStaleEntries({
              ...s.linearCustomViewIssueCache,
              [cacheKey]: { data: result, fetchedAt: Date.now() }
            })
          }))
        }
        return result
      })
      .catch((error) => {
        console.warn('[linear] listLinearCustomViewIssues failed:', error)
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        const fallback =
          get().linearCustomViewIssueCache[cacheKey]?.data ??
          largestCachedCollectionBelowLimit(
            get().linearCustomViewIssueCache,
            workspaceId,
            'custom-view-issues',
            viewId,
            effectiveLimit
          ) ??
          emptyLinearCollection<LinearIssue>()
        return collectionWithWorkspaceError(fallback, workspaceId, error)
      })
      .finally(() => {
        if (inflightCustomViewIssueRequests.get(cacheKey) === entry) {
          inflightCustomViewIssueRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightCustomViewIssueRequests.set(cacheKey, entry)
    return promise
  },

  listLinearCustomViewProjects: async (viewId, workspaceId, limit = 20, options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const cacheKey = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(workspaceId, 'custom-view-projects', viewId, limit)
    )
    const cached = get().linearCustomViewProjectCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? emptyLinearCollection<LinearProjectSummary>()
    }

    const inflight = inflightCustomViewProjectRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === linearMutationGeneration &&
      (!options?.force || inflight.force)
    ) {
      return inflight.promise
    }

    let entry: InflightLinearCollectionRequest<LinearProjectSummary>
    const requestCacheGeneration = linearCacheGeneration
    const requestMutationGeneration = linearMutationGeneration
    const promise = linearListCustomViewProjects(scope.settings, viewId, limit, workspaceId, {
      force: options?.force
    })
      .then((result) => {
        if (
          inflightCustomViewProjectRequests.get(cacheKey) === entry &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            linearCustomViewProjectCache: evictStaleEntries({
              ...s.linearCustomViewProjectCache,
              [cacheKey]: { data: result, fetchedAt: Date.now() }
            })
          }))
        }
        return result
      })
      .catch((error) => {
        console.warn('[linear] listLinearCustomViewProjects failed:', error)
        if (
          (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
        const fallback =
          get().linearCustomViewProjectCache[cacheKey]?.data ??
          emptyLinearCollection<LinearProjectSummary>()
        return collectionWithWorkspaceError(fallback, workspaceId, error)
      })
      .finally(() => {
        if (inflightCustomViewProjectRequests.get(cacheKey) === entry) {
          inflightCustomViewProjectRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
          canWriteLinearReadResult(
            contextKey,
            requestCacheGeneration,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkLinearConnection(true)
        }
      })

    entry = {
      promise,
      force: Boolean(options?.force),
      generation: requestCacheGeneration,
      contextKey,
      mutationGeneration: requestMutationGeneration
    }
    inflightCustomViewProjectRequests.set(cacheKey, entry)
    return promise
  },

  invalidateLinearIssueLists: (options) => {
    const scope = getLinearReadScope(get().settings, options?.sourceContext)
    const tokenScope = scope.cachePrefix ?? 'local'
    const nextVersion =
      linearListInvalidationToken.scope === tokenScope
        ? (linearListInvalidationToken.version + 1) % LINEAR_LIST_INVALIDATION_VERSION_CAP || 1
        : 1
    linearListInvalidationToken = { scope: tokenScope, version: nextVersion }

    // Why: drop only attribute-filtered plain list entries in this source scope
    // so the next TaskPage read is forced current without wiping search/unrelated
    // collections.
    set((s) => {
      const nextListCache = { ...s.linearListCache }
      let changed = false
      for (const key of Object.keys(nextListCache)) {
        const parts = key.split('::')
        // Cache keys end with the attribute signature; unfiltered entries end empty.
        const attributeSignature = parts.at(-1) ?? ''
        if (!attributeSignature) {
          continue
        }
        if (scope.cachePrefix) {
          if (!key.startsWith(`${scope.cachePrefix}::`)) {
            continue
          }
        } else if (parts[1] !== 'list') {
          // Why: unscoped invalidation must not touch other runtimes' scoped list keys.
          continue
        }
        delete nextListCache[key]
        inflightListRequests.delete(key)
        changed = true
      }
      if (!changed) {
        return { linearListInvalidationToken: linearListInvalidationToken }
      }
      return {
        linearListCache: nextListCache,
        linearListInvalidationToken: linearListInvalidationToken
      }
    })
  },

  patchLinearIssue: (issueId, patch, options) => {
    const sourceScope =
      options?.sourceContext?.provider === 'linear'
        ? getTaskSourceCacheScope(options.sourceContext)
        : null
    const canPatchCacheKey = (key: string): boolean =>
      sourceScope === null || key.startsWith(`${sourceScope}::`)
    set((s) => {
      let changed = false

      const nextIssueCache = { ...s.linearIssueCache }
      for (const [key, issueEntry] of Object.entries(nextIssueCache)) {
        if (!canPatchCacheKey(key) || issueEntry?.data?.id !== issueId) {
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
        if (!canPatchCacheKey(key) || !entry?.data) {
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

      const nextListCache = patchLinearIssueCollectionCache(
        s.linearListCache,
        issueId,
        patch,
        canPatchCacheKey
      )
      if (nextListCache.changed) {
        changed = true
      }

      const nextProjectIssueCache = patchLinearIssueCollectionCache(
        s.linearProjectIssueCache,
        issueId,
        patch,
        canPatchCacheKey
      )
      if (nextProjectIssueCache.changed) {
        changed = true
      }

      const nextCustomViewIssueCache = patchLinearIssueCollectionCache(
        s.linearCustomViewIssueCache,
        issueId,
        patch,
        canPatchCacheKey
      )
      if (nextCustomViewIssueCache.changed) {
        changed = true
      }

      return changed
        ? {
            linearIssueCache: nextIssueCache,
            linearSearchCache: nextSearchCache,
            linearListCache: nextListCache.changed ? nextListCache.cache : s.linearListCache,
            linearProjectIssueCache: nextProjectIssueCache.changed
              ? nextProjectIssueCache.cache
              : s.linearProjectIssueCache,
            linearCustomViewIssueCache: nextCustomViewIssueCache.changed
              ? nextCustomViewIssueCache.cache
              : s.linearCustomViewIssueCache
          }
        : {}
    })
  }
})
