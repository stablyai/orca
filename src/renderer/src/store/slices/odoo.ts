import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  OdooConnectionStatus,
  OdooInstanceSelection,
  OdooTicket,
  OdooTicketFilter,
  OdooViewer
} from '../../../../shared/odoo-types'
import type { CacheEntry } from '../github/cache-model'
import { odooGetTicket, odooListTickets, odooSearchTickets } from '@/runtime/runtime-odoo-client'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { createOdooConnectionLifecycle } from './odoo-connection-lifecycle'
import {
  evictStaleEntries,
  executeOdooRead,
  getOdooReadScope,
  getSelectedOdooInstanceId,
  isFresh,
  looksLikeOdooAuthError,
  scopedOdooCacheKey,
  shouldRefreshOdooStatusAfterRead,
  type InflightOdooRead,
  type OdooReadScope
} from './odoo-read-coordination'

type OdooReadOptions = { sourceContext?: TaskSourceContext | null; forceRefresh?: boolean }
type OdooPatchOptions = { sourceContext?: TaskSourceContext | null }

const inflightTicketRequests = new Map<string, InflightOdooRead<OdooTicket | null>>()
const inflightSearchRequests = new Map<string, InflightOdooRead<OdooTicket[]>>()
const inflightListRequests = new Map<string, InflightOdooRead<OdooTicket[]>>()

function clearOdooInflight(): void {
  inflightTicketRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

function listReadFallback(error: unknown): OdooTicket[] {
  // Credential/auth failures surface through connection state, so they keep
  // the empty-list contract. Other failures (network, 5xx, bad domain) reject
  // so the Tasks panel shows a real error, not a misleading "No tickets".
  if (looksLikeOdooAuthError(error)) {
    return []
  }
  throw error
}

export type OdooSlice = {
  odooStatus: OdooConnectionStatus
  odooStatusChecked: boolean
  odooStatusContextKey: string | null
  odooTicketCache: Record<string, CacheEntry<OdooTicket>>
  odooTicketListCache: Record<string, CacheEntry<OdooTicket[]>>

  checkOdooConnection: () => Promise<void>
  connectOdoo: (args: {
    serverUrl: string
    database: string
    login: string
    apiKey: string
  }) => Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }>
  testOdooConnection: (
    instanceId?: string | null
  ) => Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }>
  selectOdooInstance: (instanceId: OdooInstanceSelection) => Promise<void>
  disconnectOdoo: (instanceId?: string | null) => Promise<void>
  fetchOdooTicket: (
    id: number,
    instanceId?: string | null,
    options?: OdooReadOptions
  ) => Promise<OdooTicket | null>
  searchOdooTickets: (
    domain: unknown[],
    limit?: number,
    options?: OdooReadOptions
  ) => Promise<OdooTicket[]>
  listOdooTickets: (
    filter?: OdooTicketFilter,
    limit?: number,
    options?: OdooReadOptions
  ) => Promise<OdooTicket[]>
  patchOdooTicket: (
    ticketId: number,
    instanceId: string | null | undefined,
    patch: Partial<OdooTicket>,
    options?: OdooPatchOptions
  ) => void
}

export const createOdooSlice: StateCreator<AppState, [], [], OdooSlice> = (set, get) => {
  const runListRead = (
    inflight: Map<string, InflightOdooRead<OdooTicket[]>>,
    cacheKey: string,
    scope: OdooReadScope,
    instanceId: OdooInstanceSelection | null,
    forceRefresh: boolean,
    fetch: () => Promise<OdooTicket[]>
  ): Promise<OdooTicket[]> => {
    const cached = get().odooTicketListCache[cacheKey]
    if (!forceRefresh && isFresh(cached)) {
      return Promise.resolve(cached.data ?? [])
    }
    return executeOdooRead({
      inflight,
      cacheKey,
      scope,
      getState: get,
      fetch,
      writeCache: (tickets) =>
        set((s) => ({
          odooTicketListCache: evictStaleEntries({
            ...s.odooTicketListCache,
            [cacheKey]: { data: tickets, fetchedAt: Date.now() }
          })
        })),
      onAuthLost: () => set({ odooStatus: { connected: false, viewer: null } }),
      refreshStatus: () => void get().checkOdooConnection(),
      shouldRefreshAfterRead: shouldRefreshOdooStatusAfterRead(instanceId, get().odooStatus),
      fallback: listReadFallback
    })
  }

  return {
    odooStatus: { connected: false, viewer: null },
    odooStatusChecked: false,
    odooStatusContextKey: null,
    odooTicketCache: {},
    odooTicketListCache: {},

    ...createOdooConnectionLifecycle({ set, get, clearInflight: clearOdooInflight }),

    fetchOdooTicket: async (id, instanceId, options) => {
      const scope = getOdooReadScope(get().settings, options?.sourceContext)
      const cacheKey = scopedOdooCacheKey(scope, `${instanceId ?? 'selected'}::${id}`)
      const cached = get().odooTicketCache[cacheKey]
      // Why: the focus re-read and the detail panel ask for a forced refresh; honouring
      // the cache there pinned stage and assignee to a value up to the TTL old.
      if (!options?.forceRefresh && isFresh(cached)) {
        return cached.data
      }
      return executeOdooRead<OdooTicket | null>({
        inflight: inflightTicketRequests,
        cacheKey,
        scope,
        getState: get,
        fetch: () => odooGetTicket(scope.settings, id, instanceId),
        writeCache: (ticket) => {
          if (!ticket) {
            return
          }
          set((s) => ({
            odooTicketCache: evictStaleEntries({
              ...s.odooTicketCache,
              [cacheKey]: { data: ticket, fetchedAt: Date.now() }
            })
          }))
        },
        onAuthLost: () => set({ odooStatus: { connected: false, viewer: null } }),
        refreshStatus: () => void get().checkOdooConnection(),
        shouldRefreshAfterRead: shouldRefreshOdooStatusAfterRead(instanceId, get().odooStatus),
        fallback: () => null
      })
    },

    searchOdooTickets: async (domain, limit = 30, options) => {
      const scope = getOdooReadScope(get().settings, options?.sourceContext)
      const instanceId = getSelectedOdooInstanceId(get().odooStatus)
      const cacheKey = scopedOdooCacheKey(
        scope,
        `${instanceId ?? 'default'}::search::${JSON.stringify(domain)}::${limit}`
      )
      return runListRead(
        inflightSearchRequests,
        cacheKey,
        scope,
        instanceId,
        options?.forceRefresh ?? false,
        () => odooSearchTickets(scope.settings, domain, limit, instanceId)
      )
    },

    listOdooTickets: async (filter = 'assigned', limit = 30, options) => {
      const scope = getOdooReadScope(get().settings, options?.sourceContext)
      const instanceId = getSelectedOdooInstanceId(get().odooStatus)
      const cacheKey = scopedOdooCacheKey(
        scope,
        `${instanceId ?? 'default'}::list::${filter}::${limit}`
      )
      return runListRead(
        inflightListRequests,
        cacheKey,
        scope,
        instanceId,
        options?.forceRefresh ?? false,
        () => odooListTickets(scope.settings, filter, limit, instanceId)
      )
    },

    patchOdooTicket: (ticketId, instanceId, patch, options) => {
      const sourceScope =
        options?.sourceContext?.provider === 'odoo'
          ? getTaskSourceCacheScope(options.sourceContext)
          : null
      const canPatchCacheKey = (key: string): boolean =>
        sourceScope === null || key.startsWith(`${sourceScope}::`)
      // Numeric ids collide across instances, so an 'All instances' cache must
      // match the instance too; single-instance tickets omit instanceId and
      // still match by id alone.
      const matchesTicket = (ticket: OdooTicket): boolean =>
        ticket.id === ticketId &&
        (instanceId == null || ticket.instanceId == null || ticket.instanceId === instanceId)
      set((s) => {
        let changed = false
        const nextTicketCache = { ...s.odooTicketCache }
        for (const [key, entry] of Object.entries(nextTicketCache)) {
          if (!canPatchCacheKey(key) || !entry?.data || !matchesTicket(entry.data)) {
            continue
          }
          nextTicketCache[key] = { ...entry, data: { ...entry.data, ...patch }, fetchedAt: 0 }
          changed = true
        }
        const nextListCache = { ...s.odooTicketListCache }
        for (const key of Object.keys(nextListCache)) {
          const entry = nextListCache[key]
          if (!canPatchCacheKey(key) || !entry?.data) {
            continue
          }
          const index = entry.data.findIndex(matchesTicket)
          if (index === -1) {
            continue
          }
          const updatedItems = [...entry.data]
          updatedItems[index] = { ...updatedItems[index], ...patch }
          nextListCache[key] = { ...entry, data: updatedItems }
          changed = true
        }
        return changed
          ? { odooTicketCache: nextTicketCache, odooTicketListCache: nextListCache }
          : {}
      })
    }
  }
}
