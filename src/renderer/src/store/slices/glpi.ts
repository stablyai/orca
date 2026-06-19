import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlpiFollowup, GlpiTicket, GlpiWorkItemFilters } from '../../../../shared/types'
import {
  glpiAddFollowup,
  glpiConnect,
  glpiCreateTicket,
  glpiDisconnect,
  glpiFollowups,
  glpiListWorkItems,
  glpiSelectServer,
  glpiStatus,
  glpiTestConnection,
  glpiTicket,
  glpiUpdateTicket
} from '@/runtime/runtime-glpi-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getGlpiReadScope,
  getSelectedServerId,
  invalidateGlpiList,
  invalidateGlpiTicket,
  scopedGlpiCacheKey
} from './glpi-cache-keys'
import { runGlpiCachedRead } from './glpi-inflight-read'
import type { GlpiSlice } from './glpi-slice-types'

export type { GlpiSlice } from './glpi-slice-types'

type Inflight<T> = { promise: Promise<T>; contextKey: string; mutationGeneration: number }

const inflightTicketRequests = new Map<string, Inflight<GlpiTicket | null>>()
const inflightListRequests = new Map<string, Inflight<GlpiTicket[]>>()
const inflightFollowupRequests = new Map<string, Inflight<GlpiFollowup[]>>()
let glpiStatusReadGeneration = 0
let glpiMutationGeneration = 0

function clearGlpiInflight(): void {
  inflightTicketRequests.clear()
  inflightListRequests.clear()
  inflightFollowupRequests.clear()
}

function beginGlpiMutation(): number {
  glpiMutationGeneration += 1
  return glpiMutationGeneration
}

function isCurrentGlpiMutation(generation: number): boolean {
  return generation === glpiMutationGeneration
}

function isCurrentGlpiRuntimeContext(contextKey: string, settings: AppState['settings']): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

// Stable cache-key fragment for work-item filters: drop undefined fields and
// sort entries so equivalent filter sets always serialize identically.
function serializeGlpiWorkItemFilters(filters?: GlpiWorkItemFilters): string {
  if (!filters) {
    return '{}'
  }
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(Object.fromEntries(entries))
}

export const createGlpiSlice: StateCreator<AppState, [], [], GlpiSlice> = (set, get) => {
  const store = { get, set }

  return {
    glpiStatus: { connected: false, viewer: null },
    glpiStatusChecked: false,
    glpiStatusContextKey: null,
    glpiTicketCache: {},
    glpiListCache: {},
    glpiFollowupsCache: {},

    checkGlpiConnection: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const statusReadGeneration = (glpiStatusReadGeneration += 1)
      const mutationGeneration = glpiMutationGeneration
      if (get().glpiStatusContextKey !== contextKey) {
        set({ glpiStatusChecked: false })
      }
      const isStale = (): boolean =>
        mutationGeneration !== glpiMutationGeneration ||
        statusReadGeneration !== glpiStatusReadGeneration ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      try {
        const status = await glpiStatus(get().settings)
        if (isStale()) {
          return
        }
        const prev = get().glpiStatus
        if (
          prev.connected !== status.connected ||
          prev.credentialError !== status.credentialError ||
          prev.viewer?.login !== status.viewer?.login ||
          getSelectedServerId(prev) !== getSelectedServerId(status) ||
          (prev.servers?.length ?? 0) !== (status.servers?.length ?? 0)
        ) {
          set({ glpiStatus: status, glpiStatusChecked: true, glpiStatusContextKey: contextKey })
        } else if (!get().glpiStatusChecked || get().glpiStatusContextKey !== contextKey) {
          set({ glpiStatusChecked: true, glpiStatusContextKey: contextKey })
        }
      } catch {
        if (isStale()) {
          return
        }
        if (get().glpiStatus.connected) {
          set({
            glpiStatus: { connected: false, viewer: null },
            glpiStatusChecked: true,
            glpiStatusContextKey: contextKey
          })
        } else if (!get().glpiStatusChecked || get().glpiStatusContextKey !== contextKey) {
          set({ glpiStatusChecked: true, glpiStatusContextKey: contextKey })
        }
      }
    },

    connectGlpi: async (args) => {
      const requestGeneration = beginGlpiMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await glpiConnect(get().settings, args)
        if (
          result.ok &&
          isCurrentGlpiMutation(requestGeneration) &&
          isCurrentGlpiRuntimeContext(contextKey, get().settings)
        ) {
          set({
            glpiStatus: { connected: true, viewer: result.viewer },
            glpiStatusChecked: true,
            glpiStatusContextKey: contextKey
          })
          void get().checkGlpiConnection()
        }
        return result.ok ? { ok: true } : { ok: false, error: result.error }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Connection failed' }
      }
    },

    testGlpiConnection: async (serverId) => {
      const requestGeneration = beginGlpiMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const current = (): boolean =>
        isCurrentGlpiMutation(requestGeneration) &&
        isCurrentGlpiRuntimeContext(contextKey, get().settings)
      try {
        const result = await glpiTestConnection(get().settings, serverId)
        if (current()) {
          const status = await glpiStatus(get().settings)
          if (current()) {
            set({ glpiStatus: status, glpiStatusChecked: true, glpiStatusContextKey: contextKey })
          }
        }
        return result.ok ? { ok: true } : { ok: false, error: result.error }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Test failed' }
      }
    },

    selectGlpiServer: async (serverId) => {
      const requestGeneration = beginGlpiMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const status = await glpiSelectServer(get().settings, serverId)
      if (
        !isCurrentGlpiMutation(requestGeneration) ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      clearGlpiInflight()
      set({
        glpiStatus: status,
        glpiTicketCache: {},
        glpiListCache: {},
        glpiFollowupsCache: {},
        glpiStatusChecked: true,
        glpiStatusContextKey: contextKey
      })
    },

    disconnectGlpi: async (serverId) => {
      const requestGeneration = beginGlpiMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const current = (): boolean =>
        isCurrentGlpiMutation(requestGeneration) &&
        isCurrentGlpiRuntimeContext(contextKey, get().settings)
      await glpiDisconnect(get().settings, serverId)
      if (!current()) {
        return
      }
      clearGlpiInflight()
      const status = await glpiStatus(get().settings)
      if (!current()) {
        return
      }
      set({
        glpiStatus: status.connected ? status : { connected: false, viewer: null },
        glpiTicketCache: {},
        glpiListCache: {},
        glpiFollowupsCache: {},
        glpiStatusChecked: true,
        glpiStatusContextKey: contextKey
      })
    },

    fetchGlpiTicket: async (id, serverId, options) => {
      const scope = getGlpiReadScope(get().settings, options?.sourceContext)
      return runGlpiCachedRead<GlpiTicket | null>({
        store,
        scope,
        cacheKey: scopedGlpiCacheKey(scope, `${serverId ?? 'selected'}::${id}`),
        cacheField: 'glpiTicketCache',
        inflight: inflightTicketRequests,
        serverId,
        mutationGeneration: glpiMutationGeneration,
        isCurrentMutation: isCurrentGlpiMutation,
        fallback: null,
        fetch: () => glpiTicket(scope.settings, serverId, id),
        operation: 'fetchGlpiTicket'
      })
    },

    listGlpiWorkItems: async (filter, limit, filters, options) => {
      const scope = getGlpiReadScope(get().settings, options?.sourceContext)
      const serverId = options?.serverId ?? getSelectedServerId(get().glpiStatus)
      // Why: distinct filters must not share a cache slot; serialize them
      // deterministically so equivalent filter sets resolve to the same key.
      const filtersKey = serializeGlpiWorkItemFilters(filters)
      return runGlpiCachedRead<GlpiTicket[]>({
        store,
        scope,
        cacheKey: scopedGlpiCacheKey(
          scope,
          `${serverId ?? 'default'}::list::${filter}::${limit}::${filtersKey}`
        ),
        cacheField: 'glpiListCache',
        inflight: inflightListRequests,
        serverId,
        mutationGeneration: glpiMutationGeneration,
        isCurrentMutation: isCurrentGlpiMutation,
        fallback: [],
        fetch: () => glpiListWorkItems(scope.settings, serverId, filter, limit, filters),
        operation: 'listGlpiWorkItems'
      })
    },

    fetchGlpiFollowups: async (id, serverId, options) => {
      const scope = getGlpiReadScope(get().settings, options?.sourceContext)
      return runGlpiCachedRead<GlpiFollowup[]>({
        store,
        scope,
        cacheKey: scopedGlpiCacheKey(scope, `${serverId ?? 'selected'}::followups::${id}`),
        cacheField: 'glpiFollowupsCache',
        inflight: inflightFollowupRequests,
        serverId,
        mutationGeneration: glpiMutationGeneration,
        isCurrentMutation: isCurrentGlpiMutation,
        fallback: [],
        fetch: () => glpiFollowups(scope.settings, serverId, id),
        operation: 'fetchGlpiFollowups'
      })
    },

    addGlpiFollowupComment: async (id, content, serverId, options) => {
      const scope = getGlpiReadScope(get().settings, options?.sourceContext)
      const result = await glpiAddFollowup(scope.settings, serverId, id, content)
      if (result.ok) {
        invalidateGlpiTicket(id, serverId, options?.sourceContext, store)
      }
      return result
    },

    updateGlpiTicketDetail: async (id, updates, serverId, options) => {
      const scope = getGlpiReadScope(get().settings, options?.sourceContext)
      const result = await glpiUpdateTicket(scope.settings, serverId, id, updates)
      if (result.ok) {
        invalidateGlpiTicket(id, serverId, options?.sourceContext, store)
      }
      return result
    },

    createGlpiTicket: async (args, options) => {
      const scope = getGlpiReadScope(get().settings, options?.sourceContext)
      const result = await glpiCreateTicket(scope.settings, args)
      if (result.ok) {
        invalidateGlpiList(options?.sourceContext, store)
      }
      return result
    }
  }
}
