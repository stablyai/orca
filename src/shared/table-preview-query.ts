// Builds a bounded "preview the rows" query for a table/view picked in the
// schema browser. Both Postgres and MySQL accept `LIMIT n`; identifiers are
// engine-quoted (and the quote char doubled) so a schema/table name holding a
// quote or reserved word can't break out of the identifier.

import type { DbEngine } from './database-types'

// Rows fetched when previewing a table/view via a schema-tree click.
export const TABLE_PREVIEW_ROW_LIMIT = 100

function quoteIdentifier(engine: DbEngine, identifier: string): string {
  const quote = engine === 'mysql' ? '`' : '"'
  // Double the quote char so an identifier holding it can't break out.
  const escaped = identifier.split(quote).join(`${quote}${quote}`)
  return `${quote}${escaped}${quote}`
}

export function buildTablePreviewSql(
  engine: DbEngine,
  schema: string,
  table: string,
  limit: number = TABLE_PREVIEW_ROW_LIMIT
): string {
  const qualified = `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}`
  return `SELECT * FROM ${qualified} LIMIT ${limit};`
}
