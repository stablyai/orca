import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { buildTablePreviewSql } from '../../../../shared/table-preview-query'
import type {
  DbColumn,
  DbColumnListResult,
  DbConnectionInput,
  DbConnectionRuntimeState,
  DbConnectionSummary,
  DbConnectionUpdate,
  DbEncryptionStatus,
  DbIntrospectResult,
  DbQueryResult,
  DbSafeError,
  DbTable,
  DbTableListResult,
  DbTestResult,
  QueryResult
} from '../../../../shared/database-types'

// Editor + execution state for one connection's query workspace.
export type DbQueryState = { running: boolean; result?: QueryResult; error?: DbSafeError }

// Tables/views cached for one schema (lazy-loaded on schema expand).
export type DbSchemaTablesState = { tables: DbTable[]; truncated: boolean }

// Per-connection introspection cache: schemas (top level), tables per schema,
// columns per table. Purely data — the tree component owns expand/loading UI.
export type DbConnectionSchemaCache = {
  schemas: string[]
  truncated: boolean
  tables: Record<string, DbSchemaTablesState>
  columns: Record<string, DbColumn[]>
}

// Column cache key. NUL separator can't appear in an identifier, so it can't
// collide across schema/table pairs.
export function dbColumnKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`
}

function emptySchemaCache(): DbConnectionSchemaCache {
  return { schemas: [], truncated: false, tables: {}, columns: {} }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

export type DatabaseSlice = {
  // Renderer never holds passwords — only password-stripped summaries.
  dbConnections: DbConnectionSummary[]
  dbConnectionsLoaded: boolean
  // safeStorage posture; `isStrong === false` drives the warn-and-store banner.
  dbEncryptionStatus: DbEncryptionStatus | null
  // Live runtime status per connection id (idle/connecting/connected/error/lost).
  dbStatuses: Record<string, DbConnectionRuntimeState>
  // Connection whose schema is shown in the browser panel.
  activeDbConnectionId: string | null
  // Lazy introspection cache, by connection id.
  dbSchemaCache: Record<string, DbConnectionSchemaCache>
  loadDbConnections: () => Promise<void>
  addDbConnection: (input: DbConnectionInput) => Promise<DbConnectionSummary>
  updateDbConnection: (
    id: string,
    updates: DbConnectionUpdate
  ) => Promise<DbConnectionSummary | null>
  removeDbConnection: (id: string) => Promise<void>
  testDbConnection: (input: DbConnectionInput, id?: string) => Promise<DbTestResult>
  connectDbConnection: (id: string) => Promise<DbConnectionRuntimeState>
  disconnectDbConnection: (id: string) => Promise<void>
  // Applied from the main-process `database:status-changed` broadcast.
  applyDbStatus: (state: DbConnectionRuntimeState) => void
  // Subscribe to live status pushes; returns an unsubscribe. Called by the page.
  subscribeDbStatusChanges: () => () => void
  setActiveDbConnection: (id: string | null) => void
  loadDbSchemas: (id: string) => Promise<DbIntrospectResult>
  loadDbSchemaTables: (id: string, schema: string) => Promise<DbTableListResult>
  loadDbTableColumns: (id: string, schema: string, table: string) => Promise<DbColumnListResult>
  // Query workspace: editor text + run/cancel per connection.
  dbQueryText: Record<string, string>
  dbQueryState: Record<string, DbQueryState>
  setDbQueryText: (id: string, text: string) => void
  runDbQuery: (id: string, sql: string) => Promise<DbQueryResult>
  cancelDbQuery: (id: string) => Promise<void>
  // Load the first rows of a table/view into the editor and run them (schema
  // tree click). No-op if the connection is gone.
  previewDbTable: (id: string, schema: string, table: string) => Promise<void>
}

export const createDatabaseSlice: StateCreator<AppState, [], [], DatabaseSlice> = (set, get) => {
  // A non-live status (lost/idle/error) invalidates the cached schema so a
  // reconnect re-introspects fresh instead of showing stale structure.
  const dropCacheForNonLive = (state: DbConnectionRuntimeState): void => {
    if (state.status === 'connected' || state.status === 'connecting') {
      return
    }
    set((s) => {
      const patch: Partial<DatabaseSlice> = {}
      if (s.dbSchemaCache[state.id]) {
        patch.dbSchemaCache = withoutKey(s.dbSchemaCache, state.id)
      }
      // A dead connection can hold no running query; clear stale run state.
      if (s.dbQueryState[state.id]) {
        patch.dbQueryState = withoutKey(s.dbQueryState, state.id)
      }
      return patch
    })
  }

  return {
    dbConnections: [],
    dbConnectionsLoaded: false,
    dbEncryptionStatus: null,
    dbStatuses: {},
    activeDbConnectionId: null,
    dbSchemaCache: {},
    dbQueryText: {},
    dbQueryState: {},

    loadDbConnections: async () => {
      const [connections, encryptionStatus, statuses] = await Promise.all([
        window.api.database.list(),
        window.api.database.encryptionStatus(),
        window.api.database.statuses()
      ])
      set({
        dbConnections: connections,
        dbEncryptionStatus: encryptionStatus,
        dbStatuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
        dbConnectionsLoaded: true
      })
    },

    addDbConnection: async (input) => {
      const created = await window.api.database.add({ input })
      set((s) => ({ dbConnections: [...s.dbConnections, created] }))
      return created
    },

    updateDbConnection: async (id, updates) => {
      const updated = await window.api.database.update({ id, updates })
      if (updated) {
        set((s) => ({
          dbConnections: s.dbConnections.map((c) => (c.id === id ? updated : c))
        }))
      }
      return updated
    },

    removeDbConnection: async (id) => {
      // Free any held connection before dropping the record so no pool is orphaned.
      await window.api.database.disconnect({ id })
      await window.api.database.remove({ id })
      set((s) => ({
        dbConnections: s.dbConnections.filter((c) => c.id !== id),
        dbStatuses: withoutKey(s.dbStatuses, id),
        dbSchemaCache: withoutKey(s.dbSchemaCache, id),
        dbQueryText: withoutKey(s.dbQueryText, id),
        dbQueryState: withoutKey(s.dbQueryState, id),
        activeDbConnectionId: s.activeDbConnectionId === id ? null : s.activeDbConnectionId
      }))
    },

    testDbConnection: (input, id) => window.api.database.test({ input, id }),

    connectDbConnection: async (id) => {
      const state = await window.api.database.connect({ id })
      set((s) => ({
        dbStatuses: { ...s.dbStatuses, [id]: state },
        // Surface the freshly-connected connection's schema automatically.
        activeDbConnectionId: state.status === 'connected' ? id : s.activeDbConnectionId
      }))
      return state
    },

    disconnectDbConnection: async (id) => {
      await window.api.database.disconnect({ id })
      // A disconnect is a non-live transition; reuse the shared helper so stale
      // schema AND query state are both dropped (idle can hold no running query).
      const idleState: DbConnectionRuntimeState = { id, status: 'idle' }
      set((s) => ({ dbStatuses: { ...s.dbStatuses, [id]: idleState } }))
      dropCacheForNonLive(idleState)
    },

    applyDbStatus: (state) => {
      set((s) => ({ dbStatuses: { ...s.dbStatuses, [state.id]: state } }))
      dropCacheForNonLive(state)
    },

    subscribeDbStatusChanges: () =>
      window.api.database.onStatusChanged((state) => {
        set((s) => ({ dbStatuses: { ...s.dbStatuses, [state.id]: state } }))
        dropCacheForNonLive(state)
      }),

    setActiveDbConnection: (id) => {
      set({ activeDbConnectionId: id })
    },

    loadDbSchemas: async (id) => {
      const result = await window.api.database.introspect({ id })
      if (result.ok) {
        set((s) => {
          const prev = s.dbSchemaCache[id] ?? emptySchemaCache()
          return {
            dbSchemaCache: {
              ...s.dbSchemaCache,
              [id]: { ...prev, schemas: result.tree.schemas, truncated: result.tree.truncated }
            }
          }
        })
      }
      return result
    },

    loadDbSchemaTables: async (id, schema) => {
      const result = await window.api.database.introspectSchemaTables({ id, schema })
      if (result.ok) {
        set((s) => {
          const prev = s.dbSchemaCache[id] ?? emptySchemaCache()
          return {
            dbSchemaCache: {
              ...s.dbSchemaCache,
              [id]: {
                ...prev,
                tables: {
                  ...prev.tables,
                  [schema]: { tables: result.list.tables, truncated: result.list.truncated }
                }
              }
            }
          }
        })
      }
      return result
    },

    loadDbTableColumns: async (id, schema, table) => {
      const result = await window.api.database.introspectTableColumns({
        id,
        ref: { schema, table }
      })
      if (result.ok) {
        set((s) => {
          const prev = s.dbSchemaCache[id] ?? emptySchemaCache()
          return {
            dbSchemaCache: {
              ...s.dbSchemaCache,
              [id]: {
                ...prev,
                columns: { ...prev.columns, [dbColumnKey(schema, table)]: result.columns }
              }
            }
          }
        })
      }
      return result
    },

    setDbQueryText: (id, text) => {
      set((s) => ({ dbQueryText: { ...s.dbQueryText, [id]: text } }))
    },

    runDbQuery: async (id, sql) => {
      set((s) => ({ dbQueryState: { ...s.dbQueryState, [id]: { running: true } } }))
      // A cancel resolves this same promise as ok:false (the DB errors out the
      // running query), so both paths land in the finally-style state update.
      const result = await window.api.database.query({ id, sql })
      set((s) => ({
        dbQueryState: {
          ...s.dbQueryState,
          [id]: result.ok
            ? { running: false, result: result.result }
            : { running: false, error: result.error }
        }
      }))
      return result
    },

    cancelDbQuery: async (id) => {
      await window.api.database.cancelQuery({ id })
    },

    previewDbTable: async (id, schema, table) => {
      const connection = get().dbConnections.find((c) => c.id === id)
      if (!connection) {
        return
      }
      // Mirror the generated query in the editor so the user sees (and can
      // tweak/re-run) exactly what produced the preview.
      const sql = buildTablePreviewSql(connection.engine, schema, table)
      set((s) => ({ dbQueryText: { ...s.dbQueryText, [id]: sql } }))
      await get().runDbQuery(id, sql)
    }
  }
}
