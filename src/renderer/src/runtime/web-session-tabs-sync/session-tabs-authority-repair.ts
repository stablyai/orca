/**
 * Repairing a session-tabs snapshot the retired-epoch fence rejected.
 *
 * The fence is right to reject a subscription frame carrying a retired epoch — it cannot tell that
 * frame apart from a delayed one queued by a dead publisher generation, whose version can be
 * higher than the live cursor. What it cannot do is notice when the epoch's publisher is actually
 * still alive and has simply returned after another publisher briefly owned the worktree.
 *
 * So the drop is not treated as final: it schedules one authoritative census, whose answer settles
 * which epoch is current. If the epoch really is dead the census changes nothing; if it is live,
 * the census carries it and the tab lands. The fence itself is never relaxed for subscription
 * frames.
 *
 * Each mirror (local structured sessions, each paired environment) owns one lane. The census and
 * the generation fence are injected so this module depends on nothing that depends on the apply.
 */

/** Bounded so a publisher that keeps re-sending a retired epoch cannot drive an endless refetch. */
const MAX_REPAIR_ATTEMPTS = 3
const BASE_REPAIR_DELAY_MS = 250
const MAX_REPAIR_DELAY_MS = 5000
/**
 * The cap decays rather than latching. A run of transient RPC failures must not hide a tab for the
 * renderer's lifetime; once a worktree has been quiet this long, a fresh drop is a fresh problem
 * and gets its full budget back.
 */
const REPAIR_ATTEMPT_DECAY_MS = 60_000

type RepairState = {
  attempts: number
  lastAttemptAt: number
  timer: ReturnType<typeof setTimeout> | null
}

export type RetiredEpochRepairRunner = (expectedGeneration: number) => Promise<unknown>

export type SessionTabsAuthorityRepairLane = {
  /** Schedules the census for a dropped snapshot, coalescing repeat drops for one key. */
  schedule(key: string, publicationEpoch: string, runRepair: RetiredEpochRepairRunner): void
  /** Drops state for keys that no longer exist, so deleted worktrees do not leak entries. */
  forget(isGone: (key: string) => boolean): void
  resetForTests(): void
}

export function createSessionTabsAuthorityRepairLane(fence: {
  logLabel: string
  /** Omitted when the runner fences itself (the paired mirror checks its own subscription). */
  generation?: () => number
  isCurrent?: (expectedGeneration: number) => boolean
  /** Why re-check rather than trust the census: one that does not revive the epoch repaired nothing. */
  isStillRetired: (key: string, publicationEpoch: string) => boolean
}): SessionTabsAuthorityRepairLane {
  const repairsByKey = new Map<string, RepairState>()

  const repairState = (key: string, now: number): RepairState => {
    const existing = repairsByKey.get(key)
    if (!existing) {
      const created: RepairState = { attempts: 0, lastAttemptAt: now, timer: null }
      repairsByKey.set(key, created)
      return created
    }
    if (now - existing.lastAttemptAt >= REPAIR_ATTEMPT_DECAY_MS) {
      existing.attempts = 0
    }
    return existing
  }

  const clearAll = (keep: (key: string) => boolean): void => {
    for (const [key, state] of repairsByKey) {
      if (keep(key)) {
        continue
      }
      if (state.timer !== null) {
        clearTimeout(state.timer)
      }
      repairsByKey.delete(key)
    }
  }

  return {
    schedule(key, publicationEpoch, runRepair) {
      const now = Date.now()
      const state = repairState(key, now)
      if (state.timer !== null) {
        return
      }
      if (state.attempts >= MAX_REPAIR_ATTEMPTS) {
        console.warn(`[${fence.logLabel}] retired publication epoch still unrepaired`, {
          worktree: key,
          publicationEpoch,
          attempts: state.attempts,
          retryAfterMs: Math.max(0, REPAIR_ATTEMPT_DECAY_MS - (now - state.lastAttemptAt))
        })
        return
      }
      const generation = fence.generation?.() ?? 0
      const delay = Math.min(BASE_REPAIR_DELAY_MS * 2 ** state.attempts, MAX_REPAIR_DELAY_MS)
      state.attempts += 1
      state.lastAttemptAt = now
      state.timer = setTimeout(() => {
        state.timer = null
        if (fence.isCurrent && !fence.isCurrent(generation)) {
          repairsByKey.delete(key)
          return
        }
        void runRepair(generation)
          .then(() => {
            if (!fence.isStillRetired(key, publicationEpoch)) {
              repairsByKey.delete(key)
            }
          })
          .catch((error) => {
            console.warn(`[${fence.logLabel}] retired-epoch repair refresh failed`, error)
          })
      }, delay)
    },
    forget(isGone) {
      clearAll((key) => !isGone(key))
    },
    resetForTests() {
      clearAll(() => false)
    }
  }
}
