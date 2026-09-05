/**
 * Repairing a structured session snapshot the retired-epoch fence rejected.
 *
 * The fence is right to reject a subscription frame carrying a retired epoch — it cannot tell that
 * frame apart from a delayed one queued by a dead publisher generation, whose version can be
 * higher than the live cursor. What it cannot do is notice when the epoch's publisher is actually
 * still alive and has simply returned after another publisher briefly owned the worktree.
 *
 * So the drop is not treated as final: it schedules one authoritative `session.tabs.listAll`, whose
 * answer settles which epoch is current. If the epoch really is dead the census changes nothing; if
 * it is live, the census carries it and the tab lands. The fence itself is never relaxed for
 * subscription frames.
 */

import {
  isCurrentLocalStructuredSessionGeneration,
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionGeneration
} from './inventory-generation-fence'
import { refreshLocalStructuredSessionTabs } from './inventory-refresh'

/** Bounded so a publisher that keeps re-sending a retired epoch cannot drive an endless refetch. */
const MAX_REPAIR_ATTEMPTS = 3
const BASE_REPAIR_DELAY_MS = 250
const MAX_REPAIR_DELAY_MS = 5000

type RepairState = {
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
  exhausted: boolean
}

const repairsByWorktree = new Map<string, RepairState>()

function repairState(worktreeId: string): RepairState {
  const existing = repairsByWorktree.get(worktreeId)
  if (existing) {
    return existing
  }
  const created: RepairState = { attempts: 0, timer: null, exhausted: false }
  repairsByWorktree.set(worktreeId, created)
  return created
}

/**
 * Schedules the authoritative refetch for a dropped snapshot, coalescing repeat drops for the same
 * worktree into the one already pending.
 */
export function scheduleRetiredEpochRepair(worktreeId: string, publicationEpoch: string): void {
  const state = repairState(worktreeId)
  if (state.timer !== null || state.exhausted) {
    return
  }
  if (state.attempts >= MAX_REPAIR_ATTEMPTS) {
    state.exhausted = true
    console.warn('[structured-session-tabs] gave up repairing a retired publication epoch', {
      worktree: worktreeId,
      publicationEpoch,
      attempts: state.attempts
    })
    return
  }
  const generation = localStructuredSessionGeneration()
  const delay = Math.min(BASE_REPAIR_DELAY_MS * 2 ** state.attempts, MAX_REPAIR_DELAY_MS)
  state.attempts += 1
  state.timer = setTimeout(() => {
    state.timer = null
    if (!isCurrentLocalStructuredSessionGeneration(generation)) {
      repairsByWorktree.delete(worktreeId)
      return
    }
    void refreshLocalStructuredSessionTabs(generation, { authoritative: true })
      .then(() => {
        // Why re-check rather than trust the call: a refresh that succeeds without reviving the
        // epoch has not repaired anything, and counting it as success would loop forever.
        const stillRetired =
          localStructuredSessionEpochHistoryByWorktree
            .get(worktreeId)
            ?.retired.includes(publicationEpoch) ?? false
        if (!stillRetired) {
          repairsByWorktree.delete(worktreeId)
        }
      })
      .catch((error) => {
        console.warn('[structured-session-tabs] retired-epoch repair refresh failed', error)
      })
  }, delay)
}

export function resetRetiredEpochRepairsForTests(): void {
  for (const state of repairsByWorktree.values()) {
    if (state.timer !== null) {
      clearTimeout(state.timer)
    }
  }
  repairsByWorktree.clear()
}
