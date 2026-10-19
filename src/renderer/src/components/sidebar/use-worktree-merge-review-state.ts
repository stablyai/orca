import { useCallback, useEffect, useState } from 'react'
import type { WorktreeMergeReviewState } from '../../../../shared/git-merge-review'
import { getConnectionId } from '@/lib/connection-context'

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
  /** Resolves the owning host so a remote probe is not answered by the local machine. */
  worktreeId: string | null
  enabled: boolean
}): { phase: WorktreeMergeReviewPhase; syncSupported: boolean; refresh: () => void } {
  const { enabled, worktreeId, worktreePath } = args
  const [phase, setPhase] = useState<WorktreeMergeReviewPhase>('idle')
  // Why true before the probe answers: an idle card already offered sync before
  // this flag existed, and the probe corrects it on the same menu open.
  const [syncSupported, setSyncSupported] = useState(true)
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
    // Why: remote cards must ask the host that owns the checkout, not this machine.
    const connectionId = worktreeId ? (getConnectionId(worktreeId) ?? undefined) : undefined
    git
      .worktreeMergeReviewState(connectionId ? { worktreePath, connectionId } : { worktreePath })
      .then((state) => {
        if (!cancelled) {
          setPhase(state.phase)
          setSyncSupported(state.phase === 'idle' ? state.syncSupported : true)
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
  }, [enabled, refreshToken, worktreeId, worktreePath])

  return { phase, syncSupported, refresh }
}
