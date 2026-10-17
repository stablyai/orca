import { useCallback, useEffect, useState } from 'react'
import type { WorktreeMergeReviewState } from '../../../../shared/git-merge-review'

export type WorktreeMergeReviewPhase = WorktreeMergeReviewState['phase']

/**
 * Every sidebar card renders its own context-menu wrapper, and a review belongs
 * to the main checkout rather than to the card that started it — so a sync on
 * one card has to reach the wrapper mounted for another. A module-level
 * broadcast keeps that shared without a store slice that exists only to agree.
 */
const refreshListeners = new Set<() => void>()

export function requestWorktreeMergeReviewRefresh(): void {
  for (const listener of refreshListeners) {
    listener()
  }
}

/**
 * Whether the repository owning `worktreePath` has a merge awaiting review.
 *
 * Why query on open instead of subscribing: the answer lives in the main
 * checkout's `MERGE_HEAD`, which nothing in the renderer observes today, and the
 * menu is the only reader — a stale-but-refetched value costs nothing while a
 * polled one would need an invalidation signal that does not exist yet.
 */
export function useWorktreeMergeReviewState(args: {
  /** Any worktree of the repository; the host resolves the main checkout itself. */
  worktreePath: string | null
  enabled: boolean
}): { phase: WorktreeMergeReviewPhase; refresh: () => void } {
  const { enabled, worktreePath } = args
  const [phase, setPhase] = useState<WorktreeMergeReviewPhase>('idle')
  const [refreshToken, setRefreshToken] = useState(0)
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), [])

  useEffect(() => {
    refreshListeners.add(refresh)
    return () => {
      refreshListeners.delete(refresh)
    }
  }, [refresh])

  useEffect(() => {
    // Why: surfaces that host the sidebar without a preload bridge (component
    // tests, embedded views) must render the menu, not crash on the probe.
    const git = window.api?.git
    if (!enabled || !worktreePath || !git?.worktreeMergeReviewState) {
      return
    }
    let cancelled = false
    git
      .worktreeMergeReviewState({ worktreePath })
      .then((state) => {
        if (!cancelled) {
          setPhase(state.phase)
        }
      })
      .catch(() => {
        // Why: an unreachable host must not offer a merge the user cannot start.
        if (!cancelled) {
          setPhase('idle')
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled, refreshToken, worktreePath])

  return { phase, refresh }
}
