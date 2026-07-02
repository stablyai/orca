// Engine-aware SQL identifier quoting + bind-placeholder helpers, shared by the
// table-preview and data-grid query builders. Identifiers are quote-escaped (the
// quote char doubled) so a name holding a quote or reserved word can't break out
// of the identifier; VALUES are always passed as bind params, never quoted here.

import type { DbEngine } from './database-types'

export function quoteIdentifier(engine: DbEngine, identifier: string): string {
  const quote = engine === 'mysql' ? '`' : '"'
  // Double the quote char so an identifier holding it can't break out.
  const escaped = identifier.split(quote).join(`${quote}${quote}`)
  return `${quote}${escaped}${quote}`
}

// Positional bind placeholder for the nth (1-based) parameter: Postgres uses
// `$1..$n`; MySQL uses a bare `?`.
export function placeholder(engine: DbEngine, index: number): string {
  return engine === 'postgres' ? `$${index}` : '?'
}
