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
 *
 * The refresh is injected rather than imported so this module depends on nothing that in turn
 * depends on the snapshot apply — which is what lets the apply prune this module's state.
 */

import {
  isCurrentLocalStructuredSessionGeneration,
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionGeneration
} from './inventory-generation-fence'

/** Bounded so a publisher that keeps re-sending a retired epoch cannot drive an endless refetch. */
const MAX_REPAIR_ATTEMPTS = 3
const BASE_REPAIR_DELAY_MS = 250
const MAX_REPAIR_DELAY_MS = 5000
/**
 * The cap decays rather than latching. A run of transient RPC failures must not hide a chat tab for
 * the renderer's lifetime; once a worktree has been quiet this long, a fresh drop is a fresh
 * problem and gets its full budget back.
 */
const REPAIR_ATTEMPT_DECAY_MS = 60_000

type RepairState = {
  attempts: number
  lastAttemptAt: number
  timer: ReturnType<typeof setTimeout> | null
}

export type RetiredEpochRepairRunner = (expectedGeneration: number) => Promise<unknown>

const repairsByWorktree = new Map<string, RepairState>()

function repairState(worktreeId: string, now: number): RepairState {
  const existing = repairsByWorktree.get(worktreeId)
  if (!existing) {
    const created: RepairState = { attempts: 0, lastAttemptAt: now, timer: null }
    repairsByWorktree.set(worktreeId, created)
    return created
  }
  if (now - existing.lastAttemptAt >= REPAIR_ATTEMPT_DECAY_MS) {
    existing.attempts = 0
  }
  return existing
}

/**
 * Schedules the authoritative refetch for a dropped snapshot, coalescing repeat drops for the same
 * worktree into the one already pending.
 */
export function scheduleRetiredEpochRepair(
  worktreeId: string,
  publicationEpoch: string,
  runRepair: RetiredEpochRepairRunner
): void {
  const now = Date.now()
  const state = repairState(worktreeId, now)
  if (state.timer !== null) {
    return
  }
  if (state.attempts >= MAX_REPAIR_ATTEMPTS) {
    console.warn('[structured-session-tabs] retired publication epoch still unrepaired', {
      worktree: worktreeId,
      publicationEpoch,
      attempts: state.attempts,
      retryAfterMs: Math.max(0, REPAIR_ATTEMPT_DECAY_MS - (now - state.lastAttemptAt))
    })
    return
  }
  const generation = localStructuredSessionGeneration()
  const delay = Math.min(BASE_REPAIR_DELAY_MS * 2 ** state.attempts, MAX_REPAIR_DELAY_MS)
  state.attempts += 1
  state.lastAttemptAt = now
  state.timer = setTimeout(() => {
    state.timer = null
    if (!isCurrentLocalStructuredSessionGeneration(generation)) {
      repairsByWorktree.delete(worktreeId)
      return
    }
    void runRepair(generation)
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

/**
 * Drops repair state for worktrees that no longer exist, alongside the publisher cursors it
 * shadows — without this every deleted worktree leaks an entry for the renderer's lifetime.
 */
export function forgetRetiredEpochRepairsOutside(knownWorktreeIds: ReadonlySet<string>): void {
  for (const [worktreeId, state] of repairsByWorktree) {
    if (!knownWorktreeIds.has(worktreeId)) {
      if (state.timer !== null) {
        clearTimeout(state.timer)
      }
      repairsByWorktree.delete(worktreeId)
    }
  }
}

export function resetRetiredEpochRepairsForTests(): void {
  for (const state of repairsByWorktree.values()) {
    if (state.timer !== null) {
      clearTimeout(state.timer)
    }
  }
  repairsByWorktree.clear()
}
