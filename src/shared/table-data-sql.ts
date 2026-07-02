// Parameterized SQL builders for the editable data grid (Data tab) and the
// server-side re-query of free-form results. Identifiers are quote-escaped; every
// VALUE is a bind parameter (see sql-identifier). LIMIT/OFFSET are app-controlled
// integers, interpolated as truncated non-negative integers — never user input.

import type {
  DbColumnFilter,
  DbColumnSort,
  DbEngine,
  DbOrdinalSort,
  DbStatement
} from './database-types'
import { placeholder, quoteIdentifier } from './sql-identifier'

// Accumulates bind values in call order and hands back the matching engine
// placeholder for each — so params[] stays aligned with the emitted $1/$2/? marks.
function createParams(engine: DbEngine): { add(value: unknown): string; values: unknown[] } {
  const values: unknown[] = []
  return {
    add(value) {
      values.push(value)
      return placeholder(engine, values.length)
    },
    values
  }
}

function qualifiedName(engine: DbEngine, schema: string, table: string): string {
  return `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}`
}

type ParamSink = { add(value: unknown): string }

// One column-filter predicate; appends any operand to `params` as a bind value.
// Comparison operators are the SQL symbol verbatim; every operator is handled
// explicitly so a new one can't slip through unchecked.
function filterPredicate(engine: DbEngine, filter: DbColumnFilter, params: ParamSink): string {
  const col = quoteIdentifier(engine, filter.column)
  switch (filter.operator) {
    case 'is-null':
      return `${col} IS NULL`
    case 'is-not-null':
      return `${col} IS NOT NULL`
    case 'like':
      return `${col} LIKE ${params.add(filter.value)}`
    case 'ilike':
      // Postgres has ILIKE; MySQL's default collation is already case-insensitive.
      return `${col} ${engine === 'postgres' ? 'ILIKE' : 'LIKE'} ${params.add(filter.value)}`
    case '=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return `${col} ${filter.operator} ${params.add(filter.value)}`
  }
}

function whereClause(
  engine: DbEngine,
  filters: DbColumnFilter[] | undefined,
  params: ParamSink
): string {
  if (!filters || filters.length === 0) {
    return ''
  }
  return ` WHERE ${filters.map((f) => filterPredicate(engine, f, params)).join(' AND ')}`
}

function columnOrderBy(engine: DbEngine, sorts: DbColumnSort[] | undefined): string {
  if (!sorts || sorts.length === 0) {
    return ''
  }
  const cols = sorts.map(
    (s) => `${quoteIdentifier(engine, s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`
  )
  return ` ORDER BY ${cols.join(', ')}`
}

// LIMIT/OFFSET clamped to non-negative integers (app-controlled paging values).
function limitOffset(limit: number, offset: number): string {
  return ` LIMIT ${Math.max(0, Math.trunc(limit))} OFFSET ${Math.max(0, Math.trunc(offset))}`
}

export type TableSelectSpec = {
  schema: string
  table: string
  filters?: DbColumnFilter[]
  sorts?: DbColumnSort[]
  limit: number
  offset: number
}

// `SELECT * FROM t [WHERE …] [ORDER BY …] LIMIT n OFFSET m` for one page of a table.
export function buildSelectSql(engine: DbEngine, spec: TableSelectSpec): DbStatement {
  const params = createParams(engine)
  const sql =
    `SELECT * FROM ${qualifiedName(engine, spec.schema, spec.table)}` +
    whereClause(engine, spec.filters, params) +
    columnOrderBy(engine, spec.sorts) +
    limitOffset(spec.limit, spec.offset)
  return { sql, params: params.values }
}

export type TableCountSpec = { schema: string; table: string; filters?: DbColumnFilter[] }

// `SELECT COUNT(*) … [WHERE …]` for the (lazy/on-demand) total row count.
export function buildCountSql(engine: DbEngine, spec: TableCountSpec): DbStatement {
  const params = createParams(engine)
  const sql =
    `SELECT COUNT(*) AS count FROM ${qualifiedName(engine, spec.schema, spec.table)}` +
    whereClause(engine, spec.filters, params)
  return { sql, params: params.values }
}

// Shared shape for a row keyed by its primary key (values positional to keyColumns).
export type RowKeySpec = {
  schema: string
  table: string
  keyColumns: string[]
  keyValues: unknown[]
}

function keyPredicate(engine: DbEngine, spec: RowKeySpec, params: ParamSink): string {
  return spec.keyColumns
    .map((c, i) => `${quoteIdentifier(engine, c)} = ${params.add(spec.keyValues[i])}`)
    .join(' AND ')
}

// UPDATE t SET … WHERE <pk> = … — `set` maps column → new value.
export function buildUpdateByKeySql(
  engine: DbEngine,
  spec: RowKeySpec & { set: Record<string, unknown> }
): DbStatement {
  const params = createParams(engine)
  // SET params must bind before WHERE params so $n order matches values[].
  const setClause = Object.keys(spec.set)
    .map((c) => `${quoteIdentifier(engine, c)} = ${params.add(spec.set[c])}`)
    .join(', ')
  const sql =
    `UPDATE ${qualifiedName(engine, spec.schema, spec.table)} SET ${setClause}` +
    ` WHERE ${keyPredicate(engine, spec, params)}`
  return { sql, params: params.values }
}

// INSERT INTO t (…) VALUES (…) — Postgres appends RETURNING * so the caller gets
// generated keys/defaults back; MySQL has no RETURNING (caller refetches).
export function buildInsertSql(
  engine: DbEngine,
  spec: { schema: string; table: string; values: Record<string, unknown> }
): DbStatement {
  const params = createParams(engine)
  const target = qualifiedName(engine, spec.schema, spec.table)
  const cols = Object.keys(spec.values)
  if (cols.length === 0) {
    // No user-set columns → let the DB fill every column from its defaults.
    const base =
      engine === 'postgres'
        ? `INSERT INTO ${target} DEFAULT VALUES`
        : `INSERT INTO ${target} () VALUES ()`
    return { sql: engine === 'postgres' ? `${base} RETURNING *` : base, params: [] }
  }
  const colList = cols.map((c) => quoteIdentifier(engine, c)).join(', ')
  const valList = cols.map((c) => params.add(spec.values[c])).join(', ')
  const base = `INSERT INTO ${target} (${colList}) VALUES (${valList})`
  return { sql: engine === 'postgres' ? `${base} RETURNING *` : base, params: params.values }
}

// DELETE FROM t WHERE <pk> = …
export function buildDeleteByKeySql(engine: DbEngine, spec: RowKeySpec): DbStatement {
  const params = createParams(engine)
  const sql =
    `DELETE FROM ${qualifiedName(engine, spec.schema, spec.table)}` +
    ` WHERE ${keyPredicate(engine, spec, params)}`
  return { sql, params: params.values }
}

export type WrappedQuerySpec = {
  filters?: DbColumnFilter[]
  sorts?: DbOrdinalSort[]
  limit: number
  offset: number
}

// Strip trailing semicolons/whitespace so the user's SQL nests cleanly as a subquery.
function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/, '')
}

// Wrap a single free-form read as a subquery so the Query tab can sort/filter/page
// server-side. Sort is by ORDINAL position (survives duplicate output column
// names); filter is by name (the caller disables filtering duplicate-named columns).
export function buildWrappedQuerySql(
  engine: DbEngine,
  userSql: string,
  spec: WrappedQuerySpec
): DbStatement {
  const params = createParams(engine)
  const orderBy =
    spec.sorts && spec.sorts.length > 0
      ? ` ORDER BY ${spec.sorts
          .map((s) => `${Math.trunc(s.ordinal)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ')}`
      : ''
  const sql =
    `SELECT * FROM (${stripTrailingSemicolons(userSql)}) AS orca_sub` +
    whereClause(engine, spec.filters, params) +
    orderBy +
    limitOffset(spec.limit, spec.offset)
  return { sql, params: params.values }
}
