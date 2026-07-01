import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  buildCountSql,
  buildSelectSql,
  buildWrappedQuerySql
} from '../../../../shared/table-data-sql'
import { isCursorableRead } from '../../../../shared/sql-statement-classifier'
import {
  closeTab,
  defaultWorkspaceTabs,
  openTableTab,
  setActiveTab,
  type DbWorkspaceTabsState
} from '../database-workspace-tabs'
import { cycleColumnSort, cycleOrdinalSort } from '../../components/database/data-grid-sort-state'
import {
  addNewRow,
  bufferToStatements,
  discardNewRow,
  editNewRowCell,
  emptyEditBuffer,
  rowKeyFor,
  stageCellEdit,
  toggleDeleteRow,
  type DbEditBuffer
} from '../../components/database/table-data-edit-buffer'
import type {
  DbColumn,
  DbColumnFilter,
  DbColumnListResult,
  DbColumnSort,
  DbConnectionInput,
  DbConnectionRuntimeState,
  DbConnectionSummary,
  DbConnectionUpdate,
  DbEncryptionStatus,
  DbIntrospectResult,
  DbOrdinalSort,
  DbQueryResult,
  DbSafeError,
  DbTable,
  DbTableListResult,
  DbTestResult,
  QueryResult
} from '../../../../shared/database-types'

// Rows shown per page in a table Data tab; the loader fetches pageSize+1 to
// detect a next page without a COUNT query.
export const DB_TABLE_PAGE_SIZE = 100

// One table Data tab's fetch state. PK/type metadata is NOT duplicated here — it
// lives in `dbSchemaCache[id].columns[dbColumnKey(schema,table)]`.
export type DbTableDataState = {
  schema: string
  table: string
  filters: DbColumnFilter[]
  sorts: DbColumnSort[]
  offset: number
  pageSize: number
  result?: QueryResult
  hasNext: boolean
  totalCount?: number
  loading: boolean
  error?: DbSafeError
  // Staged (unsaved) cell edits / inserts / deletes for the current page.
  edit: DbEditBuffer
  // Redacted error from the last Save attempt (kept while the buffer survives).
  saveError?: DbSafeError
  // Monotonic load id — a response only commits if it's still the latest, so a
  // slow earlier fetch can't overwrite a newer sort/filter/page result.
  loadSeq: number
}

// Client-only id sequence for not-yet-inserted rows (never reaches the DB).
let newRowSeq = 0

// Server-side sort/filter/pagination applied on top of a free-form read by
// wrapping it as a subquery. `sort` is by OUTPUT ORDINAL (survives duplicate
// column names); `filters` are by name. `engaged` flips true once the user first
// sorts/filters/pages — before that the raw Run result is shown as-is.
export type DbQueryRefine = {
  baseSql: string
  sort: DbOrdinalSort | null
  filters: DbColumnFilter[]
  offset: number
  pageSize: number
  hasNext: boolean
  engaged: boolean
}

// Editor + execution state for one connection's query workspace.
export type DbQueryState = {
  running: boolean
  result?: QueryResult
  error?: DbSafeError
  // Present only when the last Run was a single read (isCursorableRead) — enables
  // the results grid's sortable/filterable headers + pagination.
  refine?: DbQueryRefine
  // Monotonic run/refine id — a response only commits if it's still the latest,
  // so a stale in-flight run or refine can't overwrite a newer result.
  querySeq?: number
}

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

// Immutably merge a patch into one table Data tab's fetch state; a no-op if the
// tab was closed mid-flight (so a late load can't resurrect a dropped tab).
function patchTableDataState(
  all: Record<string, Record<string, DbTableDataState>>,
  id: string,
  tabId: string,
  patch: Partial<DbTableDataState>
): Record<string, Record<string, DbTableDataState>> {
  const conn = all[id]
  const prev = conn?.[tabId]
  if (!prev) {
    return all
  }
  return { ...all, [id]: { ...conn, [tabId]: { ...prev, ...patch } } }
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
  // Server-side refine of the free-form results grid (wraps the last read).
  setDbQuerySort: (id: string, ordinal: number) => void
  setDbQueryFilters: (id: string, filters: DbColumnFilter[]) => void
  setDbQueryPage: (id: string, delta: number) => void
  // Workspace tab bar per connection: a permanent Query tab + a Data tab per
  // opened table. Fetch state for each Data tab keyed by connection → tabId.
  dbWorkspaceTabs: Record<string, DbWorkspaceTabsState>
  dbTableData: Record<string, Record<string, DbTableDataState>>
  // Open (or focus) a table's Data tab from the schema tree, loading its first
  // page + PK/type columns. No-op if the connection is gone.
  openDbTableTab: (id: string, schema: string, table: string) => void
  closeDbTab: (id: string, tabId: string) => void
  setActiveDbTab: (id: string, tabId: string) => void
  loadDbTableData: (id: string, tabId: string) => Promise<void>
  // Cycle a column's sort (asc → desc → off) and reload from the first page.
  setDbTableSort: (id: string, tabId: string, column: string) => void
  // Replace the active column filters and reload from the first page.
  setDbTableFilters: (id: string, tabId: string, filters: DbColumnFilter[]) => void
  // Page forward (+1) or back (-1) by pageSize.
  setDbTablePage: (id: string, tabId: string, delta: number) => void
  // Fetch the exact total row count on demand (avoids a COUNT(*) per page).
  loadDbTableCount: (id: string, tabId: string) => Promise<void>
  // ── Staged editing (applied atomically on save) ──
  stageDbCellEdit: (
    id: string,
    tabId: string,
    rowKey: string,
    column: string,
    value: unknown,
    original: unknown
  ) => void
  toggleDbDeleteRow: (id: string, tabId: string, rowKey: string) => void
  addDbNewRow: (id: string, tabId: string) => void
  editDbNewRowCell: (id: string, tabId: string, tempId: string, column: string, value: unknown) => void
  discardDbNewRow: (id: string, tabId: string, tempId: string) => void
  revertDbEdits: (id: string, tabId: string) => void
  // Apply staged edits atomically; returns true on success. Keeps the buffer on
  // failure so nothing is lost.
  saveDbEdits: (id: string, tabId: string) => Promise<boolean>
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
      // Drop the open Data tabs + their fetch state: a reconnect starts fresh.
      if (s.dbWorkspaceTabs[state.id]) {
        patch.dbWorkspaceTabs = withoutKey(s.dbWorkspaceTabs, state.id)
      }
      if (s.dbTableData[state.id]) {
        patch.dbTableData = withoutKey(s.dbTableData, state.id)
      }
      return patch
    })
  }

  // Re-run the current free-form read as a wrapped subquery with the active
  // sort/filter/offset, replacing the results grid with the requested page.
  const runRefine = async (id: string): Promise<void> => {
    const connection = get().dbConnections.find((c) => c.id === id)
    const refine = get().dbQueryState[id]?.refine
    if (!connection || !refine) {
      return
    }
    const seq = (get().dbQueryState[id]?.querySeq ?? 0) + 1
    set((s) => ({
      dbQueryState: { ...s.dbQueryState, [id]: { ...s.dbQueryState[id], running: true, querySeq: seq } }
    }))
    const statement = buildWrappedQuerySql(connection.engine, refine.baseSql, {
      filters: refine.filters,
      sorts: refine.sort ? [refine.sort] : [],
      limit: refine.pageSize + 1,
      offset: refine.offset
    })
    const res = await window.api.database.execute({ id, statement })
    set((s) => {
      const prev = s.dbQueryState[id]
      // Drop a stale refine superseded by a newer run/refine.
      if (!prev?.refine || prev.querySeq !== seq) {
        return {}
      }
      if (!res.ok) {
        return {
          dbQueryState: {
            ...s.dbQueryState,
            [id]: { ...prev, running: false, error: res.error }
          }
        }
      }
      const hasNext = res.result.rows.length > prev.refine.pageSize
      const rows = hasNext ? res.result.rows.slice(0, prev.refine.pageSize) : res.result.rows
      return {
        dbQueryState: {
          ...s.dbQueryState,
          [id]: {
            ...prev,
            running: false,
            error: undefined,
            result: { ...res.result, rows, rowCount: rows.length, truncated: false },
            refine: { ...prev.refine, hasNext, engaged: true }
          }
        }
      }
    })
  }

  const patchRefine = (id: string, patch: Partial<DbQueryRefine>): void => {
    set((s) => {
      const prev = s.dbQueryState[id]
      if (!prev?.refine) {
        return {}
      }
      return {
        dbQueryState: { ...s.dbQueryState, [id]: { ...prev, refine: { ...prev.refine, ...patch } } }
      }
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
    dbWorkspaceTabs: {},
    dbTableData: {},

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
        dbWorkspaceTabs: withoutKey(s.dbWorkspaceTabs, id),
        dbTableData: withoutKey(s.dbTableData, id),
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
      const seq = (get().dbQueryState[id]?.querySeq ?? 0) + 1
      set((s) => ({ dbQueryState: { ...s.dbQueryState, [id]: { running: true, querySeq: seq } } }))
      // A cancel resolves this same promise as ok:false (the DB errors out the
      // running query), so both paths land in the finally-style state update.
      const result = await window.api.database.query({ id, sql })
      set((s) => {
        // Drop a stale run superseded by a newer run/refine on this connection.
        if (s.dbQueryState[id]?.querySeq !== seq) {
          return {}
        }
        return {
          dbQueryState: {
            ...s.dbQueryState,
            [id]: result.ok
              ? {
                  running: false,
                  querySeq: seq,
                  result: result.result,
                  // Only a single read can be wrapped for server-side sort/filter.
                  refine: isCursorableRead(sql)
                    ? {
                        baseSql: sql,
                        sort: null,
                        filters: [],
                        offset: 0,
                        pageSize: DB_TABLE_PAGE_SIZE,
                        hasNext: false,
                        engaged: false
                      }
                    : undefined
                }
              : { running: false, querySeq: seq, error: result.error }
          }
        }
      })
      return result
    },

    cancelDbQuery: async (id) => {
      await window.api.database.cancelQuery({ id })
    },

    setDbQuerySort: (id, ordinal) => {
      const refine = get().dbQueryState[id]?.refine
      if (!refine) {
        return
      }
      patchRefine(id, { sort: cycleOrdinalSort(refine.sort, ordinal), offset: 0 })
      void runRefine(id)
    },

    setDbQueryFilters: (id, filters) => {
      if (!get().dbQueryState[id]?.refine) {
        return
      }
      patchRefine(id, { filters, offset: 0 })
      void runRefine(id)
    },

    setDbQueryPage: (id, delta) => {
      const refine = get().dbQueryState[id]?.refine
      if (!refine) {
        return
      }
      const offset = Math.max(0, refine.offset + delta * refine.pageSize)
      if (offset === refine.offset) {
        return
      }
      patchRefine(id, { offset })
      void runRefine(id)
    },

    openDbTableTab: (id, schema, table) => {
      const tabId = dbColumnKey(schema, table)
      const alreadyOpen = !!get().dbTableData[id]?.[tabId]
      set((s) => {
        const ws = s.dbWorkspaceTabs[id] ?? defaultWorkspaceTabs()
        const dbTableData = alreadyOpen
          ? s.dbTableData
          : {
              ...s.dbTableData,
              [id]: {
                ...s.dbTableData[id],
                [tabId]: {
                  schema,
                  table,
                  filters: [],
                  sorts: [],
                  offset: 0,
                  pageSize: DB_TABLE_PAGE_SIZE,
                  hasNext: false,
                  loading: true,
                  edit: emptyEditBuffer(),
                  loadSeq: 0
                }
              }
            }
        return {
          dbWorkspaceTabs: { ...s.dbWorkspaceTabs, [id]: openTableTab(ws, tabId, schema, table) },
          dbTableData
        }
      })
      if (!alreadyOpen) {
        // PK/type columns power the sort/filter affordances (and Phase 3 editing);
        // load them if the schema tree hasn't already cached them.
        if (!get().dbSchemaCache[id]?.columns[tabId]) {
          void get().loadDbTableColumns(id, schema, table)
        }
        void get().loadDbTableData(id, tabId)
      }
    },

    closeDbTab: (id, tabId) => {
      set((s) => {
        const ws = s.dbWorkspaceTabs[id]
        if (!ws) {
          return {}
        }
        const conn = s.dbTableData[id]
        return {
          dbWorkspaceTabs: { ...s.dbWorkspaceTabs, [id]: closeTab(ws, tabId) },
          dbTableData: conn ? { ...s.dbTableData, [id]: withoutKey(conn, tabId) } : s.dbTableData
        }
      })
    },

    setActiveDbTab: (id, tabId) => {
      set((s) => {
        const ws = s.dbWorkspaceTabs[id] ?? defaultWorkspaceTabs()
        return { dbWorkspaceTabs: { ...s.dbWorkspaceTabs, [id]: setActiveTab(ws, tabId) } }
      })
    },

    loadDbTableData: async (id, tabId) => {
      const connection = get().dbConnections.find((c) => c.id === id)
      const view = get().dbTableData[id]?.[tabId]
      if (!connection || !view) {
        return
      }
      const seq = view.loadSeq + 1
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          loading: true,
          error: undefined,
          loadSeq: seq
        })
      }))
      // Fetch pageSize+1 so a trailing row signals a next page without COUNT(*).
      const statement = buildSelectSql(connection.engine, {
        schema: view.schema,
        table: view.table,
        filters: view.filters,
        sorts: view.sorts,
        limit: view.pageSize + 1,
        offset: view.offset
      })
      const res = await window.api.database.execute({ id, statement })
      set((s) => {
        // Drop a stale response superseded by a newer load for this tab.
        if (s.dbTableData[id]?.[tabId]?.loadSeq !== seq) {
          return {}
        }
        if (!res.ok) {
          return {
            dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
              loading: false,
              error: res.error
            })
          }
        }
        const hasNext = res.result.rows.length > view.pageSize
        const rows = hasNext ? res.result.rows.slice(0, view.pageSize) : res.result.rows
        return {
          dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
            loading: false,
            error: undefined,
            hasNext,
            result: { ...res.result, rows, rowCount: rows.length, truncated: false },
            // A fresh page discards staged edits (navigation is gated while dirty).
            edit: emptyEditBuffer(),
            saveError: undefined
          })
        }
      })
    },

    setDbTableSort: (id, tabId, column) => {
      const view = get().dbTableData[id]?.[tabId]
      if (!view) {
        return
      }
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          sorts: cycleColumnSort(view.sorts, column),
          offset: 0
        })
      }))
      void get().loadDbTableData(id, tabId)
    },

    setDbTableFilters: (id, tabId, filters) => {
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, { filters, offset: 0 })
      }))
      void get().loadDbTableData(id, tabId)
    },

    setDbTablePage: (id, tabId, delta) => {
      const view = get().dbTableData[id]?.[tabId]
      if (!view) {
        return
      }
      const offset = Math.max(0, view.offset + delta * view.pageSize)
      if (offset === view.offset) {
        return
      }
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, { offset })
      }))
      void get().loadDbTableData(id, tabId)
    },

    loadDbTableCount: async (id, tabId) => {
      const connection = get().dbConnections.find((c) => c.id === id)
      const view = get().dbTableData[id]?.[tabId]
      if (!connection || !view) {
        return
      }
      const statement = buildCountSql(connection.engine, {
        schema: view.schema,
        table: view.table,
        filters: view.filters
      })
      const res = await window.api.database.execute({ id, statement })
      if (res.ok) {
        const total = Number(res.result.rows[0]?.[0]) || 0
        set((s) => ({
          dbTableData: patchTableDataState(s.dbTableData, id, tabId, { totalCount: total })
        }))
      }
    },

    stageDbCellEdit: (id, tabId, rowKey, column, value, original) => {
      const view = get().dbTableData[id]?.[tabId]
      if (!view) {
        return
      }
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          edit: stageCellEdit(view.edit, rowKey, column, value, original)
        })
      }))
    },

    toggleDbDeleteRow: (id, tabId, rowKey) => {
      const view = get().dbTableData[id]?.[tabId]
      if (!view) {
        return
      }
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          edit: toggleDeleteRow(view.edit, rowKey)
        })
      }))
    },

    addDbNewRow: (id, tabId) => {
      const view = get().dbTableData[id]?.[tabId]
      if (!view) {
        return
      }
      const tempId = `new-${newRowSeq++}`
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          edit: addNewRow(view.edit, tempId)
        })
      }))
    },

    editDbNewRowCell: (id, tabId, tempId, column, value) => {
      const view = get().dbTableData[id]?.[tabId]
      if (!view) {
        return
      }
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          edit: editNewRowCell(view.edit, tempId, column, value)
        })
      }))
    },

    discardDbNewRow: (id, tabId, tempId) => {
      const view = get().dbTableData[id]?.[tabId]
      if (!view) {
        return
      }
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          edit: discardNewRow(view.edit, tempId)
        })
      }))
    },

    revertDbEdits: (id, tabId) => {
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
          edit: emptyEditBuffer(),
          saveError: undefined
        })
      }))
    },

    saveDbEdits: async (id, tabId) => {
      const connection = get().dbConnections.find((c) => c.id === id)
      const view = get().dbTableData[id]?.[tabId]
      if (!connection || !view || !view.result) {
        return false
      }
      const columnNames = view.result.columns.map((c) => c.name)
      const cols = get().dbSchemaCache[id]?.columns[tabId] ?? []
      const keyColumns = cols.filter((c) => c.isPrimaryKey).map((c) => c.name)
      // No primary key → not editable; nothing safe to key writes on.
      if (keyColumns.length === 0) {
        return false
      }
      const rowsByKey: Record<string, unknown[]> = {}
      for (const row of view.result.rows) {
        rowsByKey[rowKeyFor(keyColumns, columnNames, row)] = row
      }
      let statements
      try {
        statements = bufferToStatements(
          connection.engine,
          { schema: view.schema, table: view.table, keyColumns, columnNames, rowsByKey },
          view.edit
        )
      } catch {
        // A staged row could not be keyed (e.g. its page was reloaded underneath).
        // Surface a save error and keep the buffer rather than issuing a bad write.
        set((s) => ({
          dbTableData: patchTableDataState(s.dbTableData, id, tabId, {
            saveError: {
              code: 'edit_state',
              safeMessage: 'Could not match staged changes to rows — refresh and try again.'
            }
          })
        }))
        return false
      }
      if (statements.length === 0) {
        return false
      }
      const res = await window.api.database.executeBatch({ id, statements })
      if (res.ok) {
        // Reload to show the canonical DB state (generated keys/defaults) and to
        // clear the now-applied buffer.
        await get().loadDbTableData(id, tabId)
        return true
      }
      set((s) => ({
        dbTableData: patchTableDataState(s.dbTableData, id, tabId, { saveError: res.error })
      }))
      return false
    }
  }
}
