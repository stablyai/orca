// Why: older hosts answer orcad.terminalCensus with method-not-found, so a client asks only when
// this is advertised and otherwise treats the census as unverifiable, never as zero.
export const ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY = 'orcad.terminal-census.v1' as const

// Why: an older host answers orcad.migration.* with method-not-found; a client stages, commits or
// reads a catalog only on a host advertising this, and treats its absence as a refusal.
export const ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY = 'orcad.migration-catalog.v1' as const

export const ORCAD_RUNTIME_CAPABILITIES = [
  ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
] as const
