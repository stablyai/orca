export type SqliteCellType = 'null' | 'integer' | 'real' | 'text' | 'blob'

export type SqliteCell = {
  type: SqliteCellType
  text: string
  truncated?: boolean
}

export type SqliteTableInfo = {
  name: string
  columns: string[]
}

export type SqliteDatabaseOverview = {
  tables: SqliteTableInfo[]
}

export type SqliteTablePage = {
  columns: string[]
  rows: SqliteCell[][]
  offset: number
}
