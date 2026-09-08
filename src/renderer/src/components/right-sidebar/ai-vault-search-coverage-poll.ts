import { useEffect, useSyncExternalStore } from 'react'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { searchCoverageStore } from './ai-vault-search-coverage-store'
export { AI_VAULT_SEARCH_COVERAGE_POLL_MS } from './ai-vault-search-coverage-store'

const subscribeDisabled = (): (() => void) => () => {}

export function useSearchIndexing(enabled: boolean, ownerKey = '') {
  const store = searchCoverageStore(ownerKey)
  const snapshot = useSyncExternalStore(
    enabled ? store.subscribe : subscribeDisabled,
    store.getSnapshot
  )
  return {
    ...snapshot,
    coverage: enabled ? snapshot.coverage : null,
    control: store.control,
    observe: store.observe,
    refresh: store.refresh
  }
}

export function useAiVaultSearchCoveragePoll(
  enabled: boolean,
  latest: AiVaultSearchCoverage | null = null,
  ownerKey = ''
): AiVaultSearchCoverage | null {
  const { coverage, observe } = useSearchIndexing(enabled, ownerKey)
  // Why: a search result carries coverage read at answer time, so publishing it is strictly
  // fresher than asking the index again for what the caller is already holding.
  useEffect(() => {
    if (enabled && latest) {
      observe(latest)
    }
  }, [enabled, latest, observe])
  return enabled ? (coverage ?? latest) : null
}
