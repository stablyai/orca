import type { AgentSessionModelCatalogResult } from '../agent-session-wire'

function isListedModelRow(row: unknown): row is { id: string } {
  return (
    typeof row === 'object' &&
    row !== null &&
    'id' in row &&
    typeof row.id === 'string' &&
    'efforts' in row &&
    Array.isArray(row.efforts)
  )
}

/** The ids a finished listing names; undefined for one still running, failed, empty or malformed. */
export function finishedListingIds(catalog: AgentSessionModelCatalogResult): string[] | undefined {
  const rows: unknown = catalog.origin === 'unknown' ? null : catalog.models
  return Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(isListedModelRow) &&
    !catalog.listingInProgress &&
    !catalog.unavailable
    ? rows.map((row) => row.id)
    : undefined
}

/** A running listing keeps what a finished one verified and its rows still show. */
export function listingVerifiedModelIds(
  verified: readonly string[] | undefined,
  catalog: AgentSessionModelCatalogResult,
  models: readonly { id: string }[]
): readonly string[] | undefined {
  return catalog.listingInProgress
    ? verified?.filter((id) => models.some((model) => model.id === id))
    : finishedListingIds(catalog)
}
