// Flattens the lazy schema cache + expansion state into a single virtualizable
// row list. Pure so the tree-shaping logic is unit-testable apart from the
// virtualizer and React. The component owns expansion/async state and passes it in.

import type { DbColumn, DbTable } from '../../../../shared/database-types'
import { dbColumnKey, type DbConnectionSchemaCache } from '@/store/slices/database'

// Async state for a not-yet-cached level (a schema's tables / a table's columns).
export type NodeLoadState = 'loading' | 'error'

export type SchemaTreeRow =
  | { key: string; type: 'schema'; depth: number; schema: string; expanded: boolean }
  | {
      key: string
      type: 'table'
      depth: number
      schema: string
      table: DbTable
      expanded: boolean
    }
  | {
      key: string
      type: 'column'
      depth: number
      schema: string
      table: string
      column: DbColumn
    }
  | {
      key: string
      type: 'message'
      depth: number
      variant: 'loading' | 'error' | 'empty' | 'overflow'
    }

export function buildSchemaRows(
  cache: DbConnectionSchemaCache,
  expandedSchemas: ReadonlySet<string>,
  expandedTables: ReadonlySet<string>,
  nodeState: Readonly<Record<string, NodeLoadState>>
): SchemaTreeRow[] {
  const rows: SchemaTreeRow[] = []

  for (const schema of cache.schemas) {
    const schemaExpanded = expandedSchemas.has(schema)
    rows.push({ key: `s:${schema}`, type: 'schema', depth: 0, schema, expanded: schemaExpanded })
    if (!schemaExpanded) {
      continue
    }
    appendSchemaChildren(rows, cache, schema, expandedTables, nodeState)
  }

  if (cache.truncated) {
    rows.push({ key: 's:__overflow', type: 'message', depth: 0, variant: 'overflow' })
  }
  return rows
}

function appendSchemaChildren(
  rows: SchemaTreeRow[],
  cache: DbConnectionSchemaCache,
  schema: string,
  expandedTables: ReadonlySet<string>,
  nodeState: Readonly<Record<string, NodeLoadState>>
): void {
  const tablesState = cache.tables[schema]
  if (!tablesState) {
    rows.push({
      key: `s:${schema}:pending`,
      type: 'message',
      depth: 1,
      variant: nodeState[schema] === 'error' ? 'error' : 'loading'
    })
    return
  }
  if (tablesState.tables.length === 0) {
    rows.push({ key: `s:${schema}:empty`, type: 'message', depth: 1, variant: 'empty' })
  }
  for (const table of tablesState.tables) {
    const tableKey = dbColumnKey(schema, table.name)
    const tableExpanded = expandedTables.has(tableKey)
    rows.push({
      key: `t:${tableKey}`,
      type: 'table',
      depth: 1,
      schema,
      table,
      expanded: tableExpanded
    })
    if (tableExpanded) {
      appendColumnRows(rows, cache, schema, table.name, tableKey, nodeState)
    }
  }
  if (tablesState.truncated) {
    rows.push({ key: `s:${schema}:overflow`, type: 'message', depth: 1, variant: 'overflow' })
  }
}

function appendColumnRows(
  rows: SchemaTreeRow[],
  cache: DbConnectionSchemaCache,
  schema: string,
  table: string,
  tableKey: string,
  nodeState: Readonly<Record<string, NodeLoadState>>
): void {
  const columns = cache.columns[tableKey]
  if (!columns) {
    rows.push({
      key: `t:${tableKey}:pending`,
      type: 'message',
      depth: 2,
      variant: nodeState[tableKey] === 'error' ? 'error' : 'loading'
    })
    return
  }
  if (columns.length === 0) {
    rows.push({ key: `t:${tableKey}:empty`, type: 'message', depth: 2, variant: 'empty' })
    return
  }
  for (const column of columns) {
    rows.push({
      key: `c:${tableKey}:${column.name}`,
      type: 'column',
      depth: 2,
      schema,
      table,
      column
    })
  }
}
