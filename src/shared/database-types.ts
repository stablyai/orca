export type DatabaseProviderId = 'postgres'

export type DatabaseSslMode = 'disable' | 'require' | 'verify-full'

export type DatabaseConnectionConfig = {
  providerId: DatabaseProviderId
  host: string
  port: number
  database: string
  schema?: string
  user: string
  sslMode: DatabaseSslMode
  /** Internal TLS identity retained when an SSH tunnel rewrites host to loopback. */
  tlsServerName?: string
}

export type DatabaseExecutionContext = {
  kind: 'ssh'
  connectionId: string
}

export type DatabaseTabState = {
  profileId?: string
  connection: DatabaseConnectionConfig
  queryDraft: string
  readOnly: boolean
}

export type DatabaseCredential = {
  password?: string
}

export type DatabaseColumn = {
  name: string
  dataTypeId?: number
}

export type DatabaseCellValue = string | number | boolean | null

export type DatabaseQueryResult = {
  columns: DatabaseColumn[]
  rows: DatabaseCellValue[][]
  command: string
  rowCount: number | null
  truncated: boolean
  durationMs: number
}

export type DatabaseSchemaColumn = {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
}

export type DatabaseSchemaTable = {
  schema: string
  name: string
  columns: DatabaseSchemaColumn[]
}

export type DatabaseSchemaResult = {
  tables: DatabaseSchemaTable[]
}

export type DatabaseCatalogResult = {
  databases: string[]
  schemas: string[]
  currentDatabase: string
  currentSchema: string | null
}

export type DatabaseConnectionTestResult = {
  database: string
  serverVersion: string
}

export type DatabaseConnectionRequest = {
  profileId?: string
  connection: DatabaseConnectionConfig
  credential: DatabaseCredential
  execution?: DatabaseExecutionContext
}

export type DatabaseNodeRequest = {
  execution?: DatabaseExecutionContext
}

export type DatabaseProfileSummary = {
  id: string
  name: string
  connection: DatabaseConnectionConfig
  hasSavedPassword: boolean
  createdAt: number
  updatedAt: number
}

export type DatabaseProfileListResult = {
  profiles: DatabaseProfileSummary[]
}

export type DatabaseProfileCredentialAction = 'preserve' | 'save' | 'delete'

export type DatabaseProfileSaveRequest = DatabaseNodeRequest & {
  profile: {
    id?: string
    name: string
    connection: DatabaseConnectionConfig
  }
  credential: DatabaseCredential
  credentialAction: DatabaseProfileCredentialAction
}

export type DatabaseProfileDeleteRequest = DatabaseNodeRequest & {
  profileId: string
}

export type DatabaseQueryRequest = DatabaseConnectionRequest & {
  queryId: string
  sql: string
  readOnly: boolean
  maxRows: number
  timeoutMs: number
}

export const DEFAULT_DATABASE_TAB_STATE: DatabaseTabState = {
  connection: {
    providerId: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    sslMode: 'disable'
  },
  queryDraft: 'SELECT current_database(), current_user, now();',
  readOnly: true
}
