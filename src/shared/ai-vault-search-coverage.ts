import type { AiVaultSearchCoverage, AiVaultSearchProviderCoverage } from './ai-vault-search-types'

/**
 * Silence is a bug: a provider whose transcripts were discovered but never made
 * it into the index is an error state, not an empty one. Only meaningful once
 * the backfill is done — until then zero indexed just means "not there yet".
 */
export function aiVaultSearchUnindexedProviders(
  coverage: AiVaultSearchCoverage
): AiVaultSearchProviderCoverage[] {
  if (coverage.backfill !== 'complete') {
    return []
  }
  return coverage.providers.filter(
    (provider) => (provider.filesDiscovered ?? 0) > 0 && provider.sessionsIndexed === 0
  )
}
