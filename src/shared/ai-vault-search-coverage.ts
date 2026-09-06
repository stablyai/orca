import type { AiVaultSearchCoverage, AiVaultSearchProviderCoverage } from './ai-vault-search-types'

/** Old hosts omit the flag; only an explicit `false` means the user opted out. */
export function isAiVaultSearchDisabled(
  coverage: Pick<AiVaultSearchCoverage, 'enabled'> | null | undefined
): boolean {
  return coverage?.enabled === false
}

/**
 * Silence is a bug: a provider whose transcripts were discovered but never made
 * it into the index is an error state, not an empty one. Only meaningful once
 * the backfill is done — until then zero indexed just means "not there yet".
 */
export function aiVaultSearchUnindexedProviders(
  coverage: AiVaultSearchCoverage
): AiVaultSearchProviderCoverage[] {
  if (isAiVaultSearchDisabled(coverage) || coverage.backfill !== 'complete') {
    return []
  }
  return coverage.providers.filter(
    (provider) => (provider.filesDiscovered ?? 0) > 0 && provider.sessionsIndexed === 0
  )
}
