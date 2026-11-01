import { useEffect, useState } from 'react'
import {
  retiredNamesAfterRefresh,
  selectRetiredNameRegistry,
  type RetiredNamesLoad
} from '../../../shared/worktree/retired-name-cache'
import type { RetiredNameRegistry } from '../../../shared/worktree/retired-name-registry'

/** Ask the host registry for spent names: deleted workspace paths may retain conversations. Refresh on every list mutation; creation stays ungated because the host also skips retired names. Shared caching rules live in retired-name-cache. */
export function useRetiredWorktreeNames(
  repoId: string | null | undefined,
  refreshKey: unknown
): RetiredNameRegistry {
  const [loaded, setLoaded] = useState<RetiredNamesLoad | null>(null)

  useEffect(() => {
    if (!repoId) {
      setLoaded(null)
      return
    }
    let cancelled = false
    const settle = (registry: RetiredNameRegistry | null): void => {
      if (!cancelled) {
        setLoaded((previous) => retiredNamesAfterRefresh(previous, repoId, registry))
      }
    }
    void window.api.worktrees
      .listRetiredNames({ repoId })
      .then(settle)
      .catch((err) => {
        settle(null)
        console.warn(`Failed to load retired workspace names for repo ${repoId}:`, err)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, repoId])

  return selectRetiredNameRegistry(loaded, repoId)
}
