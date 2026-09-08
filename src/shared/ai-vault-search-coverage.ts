import type {
  AiVaultSearchCoverage,
  AiVaultSearchProviderCoverage,
  AiVaultSearchResult
} from './ai-vault-search-types'

/** What a host reports while transcript search is switched off. */
const DISABLED_AI_VAULT_SEARCH_COVERAGE: AiVaultSearchCoverage = {
  enabled: false,
  sessionsIndexed: 0,
  messagesIndexed: 0,
  providers: [],
  backfill: 'idle',
  filesPending: 0,
  lastIndexedAt: null
}

/**
 * What a query answers with when there is no index to read: off, closing, or closed.
 * Why a factory: the caller owns `enabled`, and a shared result object would let one
 * consumer's mutation reach every later query.
 */
export function noAiVaultSearchIndexResult(coverage: AiVaultSearchCoverage): AiVaultSearchResult {
  return { hits: [], route: 'and', durationMs: 0, coverage }
}

/** No open index, but consent still decides `enabled`: a closing store is not an opt-out. */
export function noAiVaultSearchIndexCoverage(enabled: boolean): AiVaultSearchCoverage {
  return { ...DISABLED_AI_VAULT_SEARCH_COVERAGE, enabled }
}

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
