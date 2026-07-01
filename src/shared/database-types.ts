// Shared types for the in-app database client (Postgres/MySQL).
//
// Security model: a connection's `password` is held and persisted only in a
// tagged at-rest form (see src/main/database/db-credential-store.ts) and is
// decrypted strictly at point-of-use in the main process. It is NEVER sent to
// the renderer — the renderer only ever sees a DbConnectionSummary.

export type DbEngine = 'postgres' | 'mysql'

// 'disable' → no TLS; 'verify-full' → TLS with full cert + hostname verification;
// 'insecure-no-verify' → TLS without verification (explicit, clearly-labeled opt-in).
// An UNSET ssl on a connection means SMART-BY-HOST: localhost → disable,
// remote → verify-full (resolved at connect time in Phase 3).
export type DbSslMode = 'disable' | 'verify-full' | 'insecure-no-verify'

// Reserved SSH-tunnel binding — the model field exists in v1 but is not wired
// to SshPortForwardManager yet.
export type DbSshTunnel = { targetId: string }

// Canonical connection record as persisted in the global store. `password`
// carries the tagged at-rest secret (or is absent); main-process only.
export type DbConnection = {
  id: string
  name: string
  engine: DbEngine
  host: string
  port: number
  database: string
  user: string
  password?: string
  ssl?: DbSslMode
  readOnly: boolean
  sshTunnel?: DbSshTunnel
  createdAt: number
  updatedAt: number
}

// Renderer-facing projection: strips the secret, exposing only whether one is
// stored. The password value never crosses the IPC boundary to the renderer.
export type DbConnectionSummary = Omit<DbConnection, 'password'> & {
  hasPassword: boolean
}

// Create payload (renderer → main). `readOnly`/`ssl` optional; normalized in the
// store (readOnly defaults false; unset ssl means smart-by-host).
export type DbConnectionInput = {
  name: string
  engine: DbEngine
  host: string
  port: number
  database: string
  user: string
  password?: string
  ssl?: DbSslMode
  readOnly?: boolean
  sshTunnel?: DbSshTunnel
}

// Update payload (renderer → main). An omitted `password` leaves the stored
// secret unchanged; a non-empty `password` replaces it.
export type DbConnectionUpdate = Partial<DbConnectionInput>

// safeStorage backend posture surfaced to the connection form. `isStrong=false`
// drives the warn-and-store banner (weak/absent OS crypto backend).
export type DbEncryptionStatus = {
  backend: string
  isStrong: boolean
}

// Default TCP ports per engine — UI convenience for the connection form.
export const DB_DEFAULT_PORT: Record<DbEngine, number> = {
  postgres: 5432,
  mysql: 3306
}

// ── Live connection runtime state (Phase 3) ──────────────────────────
//
// Ephemeral state owned by the main-process connection manager, distinct
// from the persisted DbConnection record. Pushed to the renderer over the
// `database:status-changed` event; never written to disk.
//   idle       → no live connection held
//   testing    → one-shot Test Connection in flight
//   connecting → opening a held connection
//   connected  → live connection held
//   error      → last connect/test attempt failed
//   lost       → was connected, then dropped (driver 'error' event) — no crash
export type DbConnectionStatus =
  | 'idle'
  | 'testing'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'lost'

// Redacted error that may cross the IPC boundary. Raw driver errors embed DSNs
// and passwords, so the main process maps them to a fixed { code, safeMessage }
// from an allow-list — never the raw message.
export type DbSafeError = {
  code: string
  safeMessage: string
}

// Runtime state for a single connection id (renderer mirror of manager state).
export type DbConnectionRuntimeState = {
  id: string
  status: DbConnectionStatus
  error?: DbSafeError
}

// Result of a one-shot Test Connection. Returned (not thrown) so a failure
// carries only the redacted error, never a raw rejection message.
export type DbTestResult = { ok: true } | { ok: false; error: DbSafeError }

// ── Schema introspection (Phase 4) ───────────────────────────────────
//
// Unified model across engines: a connection exposes browsable SCHEMAS, each
// holding tables/views, each holding columns. Postgres schemas are namespaces
// within the connected database; MySQL "databases" map onto this schema level.
// Every level is fetched lazily and row-capped (red-team F9) — `truncated`
// marks a level the server has more of than the cap allowed.
export type DbColumn = {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
}

export type DbTable = {
  name: string
  kind: 'table' | 'view'
}

// Reference to a table for lazy column loading.
export type DbTableRef = {
  schema: string
  table: string
}

// Top-level namespaces on a connection (names only; tables load per schema).
export type DbSchemaTree = {
  schemas: string[]
  truncated: boolean
}

// Tables/views within one schema.
export type DbTableList = {
  tables: DbTable[]
  truncated: boolean
}

// Introspection IPC results — returned (not thrown) so a failure carries only
// the redacted error and the tree never crashes on a bad introspection.
export type DbIntrospectResult = { ok: true; tree: DbSchemaTree } | { ok: false; error: DbSafeError }
export type DbTableListResult =
  | { ok: true; list: DbTableList }
  | { ok: false; error: DbSafeError }
export type DbColumnListResult =
  | { ok: true; columns: DbColumn[] }
  | { ok: false; error: DbSafeError }

// ── Query execution (Phase 5) ────────────────────────────────────────
//
// Results are transported as column metadata + row arrays (positional, so
// duplicate column names survive). A server-side cursor bounds the row count;
// `truncated` marks that the query produced more than the cap.
export type QueryColumn = { name: string; dataType?: string }

export type QueryResult = {
  columns: QueryColumn[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  durationMs: number
}

// Server-controlled execution options. `allowWrite` is derived from the stored
// connection's `readOnly` in the main process — never trusted from the renderer.
export type QueryOptions = {
  rowLimit: number
  timeoutMs: number
  allowWrite: boolean
}

// Identifies a running query so it can be cancelled server-side. `backendPid` is
// the Postgres backend PID / MySQL connection id captured at query start.
export type QueryHandle = {
  connectionId: string
  backendPid: number | null
}

// Query IPC result — returned (not thrown) so a SQL error carries only the
// redacted error, never a raw driver message with the DSN.
export type DbQueryResult = { ok: true; result: QueryResult } | { ok: false; error: DbSafeError }

// ── Data grid: parameterized sort / filter / edit (Data tab) ──────────
//
// The renderer builds parameterized statements — identifiers are quote-escaped
// (see src/shared/sql-identifier.ts), every VALUE is a bind parameter, and
// LIMIT/OFFSET are app-controlled integers. Values are never string-interpolated.
// These run through database:execute (one statement) / database:executeBatch
// (staged edits applied atomically), which derive allowWrite server-side.

// A parameterized statement: engine-native placeholders ($1.. / ?) in `sql`,
// ordered bind values in `params`.
export type DbStatement = { sql: string; params: unknown[] }

export type DbSortDirection = 'asc' | 'desc'

// Sort a Data-tab table by column name (SELECT * → the column names are unique).
export type DbColumnSort = { column: string; direction: DbSortDirection }

// Sort wrapped free-form results by 1-based output position — survives duplicate
// column names, which ORDER BY <name> cannot resolve.
export type DbOrdinalSort = { ordinal: number; direction: DbSortDirection }

// Column filter operators. `is-null`/`is-not-null` take no value; `like`/`ilike`
// match a pattern; the rest are scalar comparisons. `ilike` falls back to LIKE on
// MySQL (whose default collation is already case-insensitive).
export type DbFilterOperator =
  | '='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='
  | 'like'
  | 'ilike'
  | 'is-null'
  | 'is-not-null'

// is-null/is-not-null take no value; every other operator requires one — the
// union forces a value to be present exactly when the operator needs it, so a
// comparison/pattern filter can never bind an accidental `undefined`.
export type DbColumnFilter =
  | { column: string; operator: 'is-null' | 'is-not-null' }
  | {
      column: string
      operator: Exclude<DbFilterOperator, 'is-null' | 'is-not-null'>
      value: unknown
    }

// database:execute result — a single parameterized statement (Data-tab
// select/count, or a wrapped free-form re-query). Same shape as a plain query.
export type DbExecuteResult = DbQueryResult

// database:executeBatch result — staged edits applied atomically in one
// transaction. On failure, `failedIndex` is the 0-based statement that errored,
// or -1 when the batch failed before/around statement execution (e.g. not connected).
export type DbBatchResult =
  | { ok: true; rowCounts: number[] }
  | { ok: false; error: DbSafeError; failedIndex: number }
