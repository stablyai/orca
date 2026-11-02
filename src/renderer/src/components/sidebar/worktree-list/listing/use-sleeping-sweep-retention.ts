import { useEffect, useMemo, useRef, useState } from 'react'
import { hasActiveWorkspaceActivity } from '@/lib/worktree-activity-state'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { VisibleWorktreeOptions } from '../../compute-visible-worktrees'
import {
  cloneSleepingSweepRetentionState,
  createSleepingSweepRetentionState,
  updateSleepingSweepRetention
} from '../../../../../../shared/sidebar-list/sleeping-sweep-retention'

type SweepActivityInputs = Pick<
  VisibleWorktreeOptions,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'browserTabsByWorktree'
  | 'worktreeIdsWithLiveAgent'
  | 'worktreeIdsWithStructuredChat'
>

/** Rows the "Hide sleeping" sweep must keep through a transient PTY rebind gap (#15996). */
export function useSleepingSweepRetention(
  args: SweepActivityInputs & {
    enabled: boolean
    worktreesByRepo: Record<string, Worktree[]>
  }
): ReadonlySet<string> | undefined {
  const {
    enabled,
    worktreesByRepo,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat
  } = args
  const committedStateRef = useRef(createSleepingSweepRetentionState())
  const [graceTick, setGraceTick] = useState(0)

  const pass = useMemo(() => {
    void graceTick
    if (!enabled) {
      return { retainedIds: undefined, nextExpiryInMs: null, state: null }
    }
    // Why clone: an abandoned render must not start, prune or reset grace windows.
    const state = cloneSleepingSweepRetentionState(committedStateRef.current)
    const { retainedIds, nextExpiryInMs } = updateSleepingSweepRetention({
      state,
      candidateWorktreeIds: getIndexedAllWorktrees(worktreesByRepo).map((w) => w.id),
      isActive: (worktreeId) =>
        hasActiveWorkspaceActivity(
          worktreeId,
          tabsByWorktree,
          ptyIdsByTabId,
          browserTabsByWorktree,
          worktreeIdsWithLiveAgent,
          worktreeIdsWithStructuredChat
        ),
      // Why: an empty binding on a still-open tab is unverifiable; a deliberate sleep or a closed last tab is not.
      isUnverifiableGap: (worktreeId) =>
        !hasWorktreeSleepIntent(worktreeId) && (tabsByWorktree?.[worktreeId]?.length ?? 0) > 0,
      // oxlint-disable-next-line react/purity -- Grace windows need wall time; the agent epoch sample stalls between bumps.
      nowMs: Date.now()
    })
    return { retainedIds, nextExpiryInMs, state }
  }, [
    enabled,
    graceTick,
    worktreesByRepo,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat
  ])

  useEffect(() => {
    committedStateRef.current = pass.state ?? createSleepingSweepRetentionState()
  }, [pass.state])

  // Wake at expiry or the final grace window would retain its row until an unrelated store write.
  const { nextExpiryInMs } = pass
  useEffect(() => {
    if (nextExpiryInMs === null) {
      return
    }
    const timer = setTimeout(() => setGraceTick((tick) => tick + 1), nextExpiryInMs)
    return () => clearTimeout(timer)
  }, [nextExpiryInMs])

  return pass.retainedIds
}
