/**
 * Repairing a remote session-tabs snapshot the retired-epoch fence rejected.
 *
 * The fence is right to reject a subscription frame carrying a retired epoch — it cannot tell that
 * frame apart from a delayed one queued by a dead publisher generation. What it cannot do is notice
 * when the epoch's publisher is actually still alive and has simply returned after another publisher
 * briefly owned the worktree (renderer → temporary headless → renderer again).
 *
 * So the drop is not treated as final: it schedules one authoritative `session.tabs.list`, whose
 * answer settles which epoch is current. If the epoch really is dead the census changes nothing; if
 * it is live, the census carries it and the tabs land. The fence itself is never relaxed for
 * subscription frames.
 *
 * The refresh is loaded dynamically so this module does not create a static cycle with the snapshot
 * refresh path that consumes the repaired decision.
 */

import { isRetiredSessionTabsPublicationEpoch } from './publisher-identity-fences'
import { sessionTabsTrackingGenerationByEnvironment } from './state'

/** Bounded so a publisher that keeps re-sending a retired epoch cannot drive an endless refetch. */
const MAX_REPAIR_ATTEMPTS = 3
const BASE_REPAIR_DELAY_MS = 250
const MAX_REPAIR_DELAY_MS = 5000
/**
 * The cap decays rather than latching. A run of transient RPC failures must not hide host tabs for
 * the client's lifetime; once a worktree has been quiet this long, a fresh drop is a fresh problem
 * and gets its full budget back.
 */
const REPAIR_ATTEMPT_DECAY_MS = 60_000

type RepairState = {
  attempts: number
  lastAttemptAt: number
  timer: ReturnType<typeof setTimeout> | null
}

export type WebRetiredEpochRepairRunner = () => Promise<unknown>

const repairsByKey = new Map<string, RepairState>()

/**
 * Production mounts flip this on. Unit tests that only exercise the fence stay silent — otherwise
 * every retired-frame assertion would schedule a real `session.tabs.list` refresh timer.
 */
let webRetiredEpochRepairEnabled = false

/** Called once when the web session-tabs mirror mounts. */
export function enableWebRetiredEpochRepair(): void {
  webRetiredEpochRepairEnabled = true
}

export function disableWebRetiredEpochRepairForTests(): void {
  webRetiredEpochRepairEnabled = false
}

function repairKey(environmentId: string, worktreeId: string): string {
  // Same shape as sessionTabsFreshnessKey; inlined so this module does not import tracking.
  return `${environmentId}:${worktreeId}`
}

function repairState(key: string, now: number): RepairState {
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

/**
 * Schedules the authoritative refetch for a dropped snapshot, coalescing repeat drops for the same
 * environment/worktree into the one already pending.
 */
export function scheduleWebRetiredEpochRepair(
  environmentId: string,
  worktreeId: string,
  publicationEpoch: string,
  runRepair?: WebRetiredEpochRepairRunner
): void {
  const key = repairKey(environmentId, worktreeId)
  const now = Date.now()
  const state = repairState(key, now)
  if (state.timer !== null) {
    return
  }
  if (state.attempts >= MAX_REPAIR_ATTEMPTS) {
    console.warn('[web-session-tabs] retired publication epoch still unrepaired', {
      environmentId,
      worktree: worktreeId,
      publicationEpoch,
      attempts: state.attempts,
      retryAfterMs: Math.max(0, REPAIR_ATTEMPT_DECAY_MS - (now - state.lastAttemptAt))
    })
    return
  }
  // An explicit runner (tests / injected) always schedules. The default production runner only runs
  // after the mirror has enabled repair, so fence-only unit tests do not open refresh timers.
  if (!runRepair && !webRetiredEpochRepairEnabled) {
    return
  }
  const trackingKey = environmentId.trim()
  const expectedTrackingGeneration =
    sessionTabsTrackingGenerationByEnvironment.get(trackingKey) ?? 0
  const delay = Math.min(BASE_REPAIR_DELAY_MS * 2 ** state.attempts, MAX_REPAIR_DELAY_MS)
  state.attempts += 1
  state.lastAttemptAt = now
  state.timer = setTimeout(() => {
    state.timer = null
    if (
      (sessionTabsTrackingGenerationByEnvironment.get(trackingKey) ?? 0) !==
      expectedTrackingGeneration
    ) {
      repairsByKey.delete(key)
      return
    }
    const runner =
      runRepair ??
      (async () => {
        const { refreshWebRuntimeSessionTabsSnapshot } = await import(
          '../web-runtime-session-snapshot'
        )
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
          authoritative: true
        })
      })
    void runner()
      .then(() => {
        // Why re-check rather than trust the call: a refresh that succeeds without reviving the
        // epoch has not repaired anything, and counting it as success would loop forever.
        if (!isRetiredSessionTabsPublicationEpoch(key, publicationEpoch)) {
          repairsByKey.delete(key)
        }
      })
      .catch((error) => {
        console.warn('[web-session-tabs] retired-epoch repair refresh failed', error)
        // Transient RPC failure: schedule another bounded attempt while this tracking generation
        // is still current and budget remains. A successful census that leaves the epoch retired
        // must not retry here — that confirmation is handled in `.then` above without rearming.
        if (
          (sessionTabsTrackingGenerationByEnvironment.get(trackingKey) ?? 0) !==
          expectedTrackingGeneration
        ) {
          repairsByKey.delete(key)
          return
        }
        scheduleWebRetiredEpochRepair(environmentId, worktreeId, publicationEpoch, runRepair)
      })
  }, delay)
}

/** Drops repair state for worktrees that no longer exist on this environment. */
export function forgetWebRetiredEpochRepairsOutside(
  environmentId: string,
  knownWorktreeIds: ReadonlySet<string>
): void {
  const prefix = `${environmentId}:`
  for (const [key, state] of repairsByKey) {
    if (!key.startsWith(prefix)) {
      continue
    }
    const worktreeId = key.slice(prefix.length)
    if (!knownWorktreeIds.has(worktreeId)) {
      if (state.timer !== null) {
        clearTimeout(state.timer)
      }
      repairsByKey.delete(key)
    }
  }
}

export function forgetWebRetiredEpochRepairsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const key = repairKey(environmentId, worktreeId)
  const state = repairsByKey.get(key)
  if (!state) {
    return
  }
  if (state.timer !== null) {
    clearTimeout(state.timer)
  }
  repairsByKey.delete(key)
}

export function resetWebRetiredEpochRepairsForTests(): void {
  for (const state of repairsByKey.values()) {
    if (state.timer !== null) {
      clearTimeout(state.timer)
    }
  }
  repairsByKey.clear()
  webRetiredEpochRepairEnabled = false
}
