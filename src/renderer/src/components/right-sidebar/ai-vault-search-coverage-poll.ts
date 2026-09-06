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
export function useAiVaultSearchCoveragePoll(enabled: boolean): AiVaultSearchCoverage | null {
  const [coverage, setCoverage] = useState<AiVaultSearchCoverage | null>(null)

  useEffect(() => {
    if (!enabled) {
      setCoverage(null)
      return
    }
    let stopped = false
    let generation = 0
    // One interval, cleared unconditionally on unmount; the reads it drives stop
    // once the backfill is complete because there is nothing left to watch.
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
          setCoverage(next)
          if (next.backfill !== 'running') {
            clearInterval(interval)
          }
        })
        .catch(() => undefined)
    }
    read()
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [enabled])

  return coverage
}
