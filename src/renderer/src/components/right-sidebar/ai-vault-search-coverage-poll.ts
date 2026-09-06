import { useEffect, useState } from 'react'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'

/** Slow enough to be invisible in profiles, fast enough to see the backfill finish. */
export const AI_VAULT_SEARCH_COVERAGE_POLL_MS = 4_000

/**
 * Coverage for the empty-query case, where no search runs and the panel would
 * otherwise have nothing to report while the index is still being built.
 *
 * Safe to call repeatedly: reading coverage is observational and never starts a
 * backfill, so polling cannot turn indexing on behind the user's back.
 */
export function useAiVaultSearchCoveragePoll(
  enabled: boolean,
  latest: AiVaultSearchCoverage | null = null
): AiVaultSearchCoverage | null {
  const [snapshot, setSnapshot] = useState<{
    source: AiVaultSearchCoverage | null
    value: AiVaultSearchCoverage
  } | null>(null)

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null)
      return
    }
    let stopped = false
    let generation = 0
    // A completed index can restart after Clear or a retention change in Settings.
    const interval = setInterval(() => {
      read()
    }, AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    function read(): void {
      generation += 1
      const issued = generation
      void window.api.aiVault
        .searchCoverage()
        .then((next) => {
          // Why: a slow 'running' answer must not land after a newer 'complete'.
          if (stopped || issued !== generation) {
            return
          }
          setSnapshot({ source: latest, value: next })
        })
        .catch(() => undefined)
    }
    read()
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [enabled, latest])

  return enabled ? (snapshot?.source === latest ? snapshot.value : latest) : null
}
