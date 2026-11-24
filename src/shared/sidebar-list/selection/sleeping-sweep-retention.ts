/** Rebinds temporarily clear live tab bindings (#15996); retain previously live rows through that unverifiable gap
 * without requiring recovery state from producers. New activity appears immediately; never-live or confirmed-sleep rows get no grace. */

// Why 1.5s: covers a remote rebind over a slow link while a real sleep still reads as prompt.
export const SLEEPING_SWEEP_SETTLE_MS = 1_500

export type SleepingSweepRetentionState = {
  /** Workspaces observed live at least once; only these earn a grace window. */
  seenActiveIds: Set<string>
  /** worktreeId -> epoch ms it first read inactive after having been live. */
  inactiveSinceById: Map<string, number>
}

export function createSleepingSweepRetentionState(): SleepingSweepRetentionState {
  return { seenActiveIds: new Set(), inactiveSinceById: new Map() }
}

export function cloneSleepingSweepRetentionState(
  state: SleepingSweepRetentionState
): SleepingSweepRetentionState {
  return {
    seenActiveIds: new Set(state.seenActiveIds),
    inactiveSinceById: new Map(state.inactiveSinceById)
  }
}

export type SleepingSweepRetentionResult = {
  /** Ids the sweep must skip this pass. */
  retainedIds: ReadonlySet<string>
  /** ms until the soonest grace window expires, or null when none is open. */
  nextExpiryInMs: number | null
}

const EMPTY_RETAINED_IDS: ReadonlySet<string> = new Set()

/** Mutate grace state idempotently for identical time/inputs so double renders cannot double-count. */
export function updateSleepingSweepRetention(args: {
  state: SleepingSweepRetentionState
  candidateWorktreeIds: readonly string[]
  isActive: (worktreeId: string) => boolean
  /** False when the inactivity is definitive (explicit sleep, last tab closed). */
  isUnverifiableGap?: (worktreeId: string) => boolean
  nowMs: number
  settleMs?: number
}): SleepingSweepRetentionResult {
  const { state, candidateWorktreeIds, isActive, nowMs } = args
  const settleMs = args.settleMs ?? SLEEPING_SWEEP_SETTLE_MS
  const candidates = new Set(candidateWorktreeIds)

  // Why prune first: a removed workspace must not hand its grace window to a reused id.
  for (const id of state.seenActiveIds) {
    if (!candidates.has(id)) {
      state.seenActiveIds.delete(id)
      state.inactiveSinceById.delete(id)
    }
  }

  let retainedIds: Set<string> | null = null
  let nextExpiryInMs: number | null = null

  for (const worktreeId of candidates) {
    if (isActive(worktreeId)) {
      state.seenActiveIds.add(worktreeId)
      state.inactiveSinceById.delete(worktreeId)
      continue
    }
    if (!state.seenActiveIds.has(worktreeId)) {
      continue
    }
    if (args.isUnverifiableGap && !args.isUnverifiableGap(worktreeId)) {
      state.seenActiveIds.delete(worktreeId)
      state.inactiveSinceById.delete(worktreeId)
      continue
    }
    let inactiveSince = state.inactiveSinceById.get(worktreeId)
    if (inactiveSince === undefined) {
      inactiveSince = nowMs
      state.inactiveSinceById.set(worktreeId, inactiveSince)
    }
    const remainingMs = settleMs - (nowMs - inactiveSince)
    if (remainingMs <= 0) {
      state.seenActiveIds.delete(worktreeId)
      state.inactiveSinceById.delete(worktreeId)
      continue
    }
    retainedIds ??= new Set()
    retainedIds.add(worktreeId)
    nextExpiryInMs = nextExpiryInMs === null ? remainingMs : Math.min(nextExpiryInMs, remainingMs)
  }

  return { retainedIds: retainedIds ?? EMPTY_RETAINED_IDS, nextExpiryInMs }
}
