// Initial-state builder and shared types for ConnectionForm.
// Extracted to keep ConnectionForm.tsx under the max-lines limit while
// keeping the reset logic in a focused, testable module.
import type { DbConnectionSummary, DbEngine, DbSslMode } from '../../../../shared/database-types'
import { DB_DEFAULT_PORT } from '../../../../shared/database-types'

// '' represents "Auto (smart by host)" in the SSL select; maps to undefined in the payload.
export type SslFieldValue = '' | DbSslMode

export type ConnectionFormState = {
  name: string
  engine: DbEngine
  host: string
  port: string
  database: string
  user: string
  ssl: SslFieldValue
  readOnly: boolean
}

export function buildInitialState(
  connection: DbConnectionSummary | undefined
): ConnectionFormState {
  if (connection) {
    return {
      name: connection.name,
      engine: connection.engine,
      host: connection.host,
      port: connection.port.toString(),
      database: connection.database,
      user: connection.user,
      ssl: connection.ssl ?? '',
      readOnly: connection.readOnly
    }
  }
  return {
    name: '',
    engine: 'postgres',
    host: '',
    port: DB_DEFAULT_PORT.postgres.toString(),
    database: '',
    user: '',
    ssl: '',
    readOnly: false
  }
}
