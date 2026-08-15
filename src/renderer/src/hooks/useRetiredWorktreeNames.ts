import { useEffect, useState } from 'react'
import {
  retiredNamesAfterRefresh,
  selectRetiredNameRegistry,
  type RetiredNamesLoad
} from '../../../shared/worktree/retired-name-cache'
import type { RetiredNameRegistry } from '../../../shared/worktree/retired-name-registry'

/** Names already spent in a repo, including workspaces that have since been deleted.
 *
 *  Why this is fetched rather than derived from the worktree list: a deleted workspace leaves no
 *  row behind, but its directory may still hold agent conversation state keyed by that path. Only
 *  the host-side registry remembers it, so name suggestions must ask for it explicitly.
 *
 *  `refreshKey` must change on every workspace-list mutation, so create-multiple refetches after
 *  each create. Caching rules live in `retired-name-cache` because the mobile hook obeys the same
 *  ones over a different transport.
 *
 *  Deliberately reports no loading state: create is never gated on this fetch — the host skips
 *  retired candidates before any git work, so a pending fetch can only cost a suggestion. */
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
