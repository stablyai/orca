import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt
} from '../../../../shared/agent-status-types'

export type FreshnessSchedulerDeps = {
  getStatusEntries: () => Record<string, AgentStatusEntry>
  bumpEpochs: () => void
}

/**
 * One accepted live-map replacement, described well enough to move the cached freshness minimum
 * without rescanning the map. `previousEntries` is the map the change was derived from, so a
 * writer that never reports its change simply invalidates the cache instead of corrupting it.
 */
export type FreshnessLiveEntryDelta = {
  previousEntries: Record<string, AgentStatusEntry>
  nextEntries: Record<string, AgentStatusEntry>
  nextEntry: AgentStatusEntry
  replacedEntry: AgentStatusEntry | undefined
  evictedEntries: readonly AgentStatusEntry[]
}

export type FreshnessScheduler = {
  schedule: () => void
  /**
   * Defer a freshness scan until the microtask queue drains. Multiple pending
   * requests still retain their queue slots for ordering, but only the newest
   * request performs the scan.
   */
  scheduleDeferred: () => void
  noteLiveEntryDelta: (delta: FreshnessLiveEntryDelta) => void
  /**
   * Cancel any pending freshness timer. Intended for tests that create a
   * fresh store per case — production callers do not need this because the
   * zustand store is a module-level singleton that lives until process exit.
   */
  dispose: () => void
}

/** Deterministic scan accounting for the freshness ratchet test and the freshness benchmark. */
export const agentStatusFreshnessScanCounters = {
  fullScans: 0,
  cachedScans: 0,
  entryVisits: 0
}

export function resetAgentStatusFreshnessScanCounters(): void {
  agentStatusFreshnessScanCounters.fullScans = 0
  agentStatusFreshnessScanCounters.cachedScans = 0
  agentStatusFreshnessScanCounters.entryVisits = 0
}

type EntryExpiries = { hookExpiryAt: number; completionExpiryAt: number | null }

function entryExpiries(entry: AgentStatusEntry): EntryExpiries {
  const completedAt = agentEntryCompletionAt(entry)
  return {
    hookExpiryAt: agentStatusEvidenceObservedAt(entry) + AGENT_STATUS_STALE_AFTER_MS,
    completionExpiryAt: completedAt === null ? null : completedAt + AGENT_STATUS_STALE_AFTER_MS
  }
}

/**
 * Summary of the last full scan. `minExpiryAt` / `minCompletionExpiryAt` are the minima over the
 * candidates that were still in the future at `scannedAt`; candidates already past then can never
 * re-enter either answer, because time only moves forward and an entry's candidates are fixed.
 */
type FreshnessScanCache = {
  entries: Record<string, AgentStatusEntry>
  scannedAt: number
  minExpiryAt: number
  minCompletionExpiryAt: number
  size: number
}

export function createFreshnessScheduler(deps: FreshnessSchedulerDeps): FreshnessScheduler {
  // Why: tests that trigger scheduling must use vi.useFakeTimers() or call
  // `dispose()` in teardown — otherwise a real 30-minute setTimeout leaks
  // into the test process.
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastCheckedAt: number | null = null
  let deferredScheduleGeneration = 0
  let cache: FreshnessScanCache | null = null

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const scheduleDeferred = (): void => {
    const generation = ++deferredScheduleGeneration
    queueMicrotask(() => {
      if (generation !== deferredScheduleGeneration) {
        return
      }
      schedule()
    })
  }

  const noteLiveEntryDelta = (delta: FreshnessLiveEntryDelta): void => {
    if (cache === null || cache.entries !== delta.previousEntries) {
      cache = null
      return
    }
    const departing =
      delta.replacedEntry === undefined
        ? delta.evictedEntries
        : [delta.replacedEntry, ...delta.evictedEntries]
    for (const entry of departing) {
      const { hookExpiryAt, completionExpiryAt } = entryExpiries(entry)
      // A departing row that holds (or ties) a cached minimum leaves it unknowable without a scan.
      if (
        hookExpiryAt === cache.minExpiryAt ||
        (completionExpiryAt !== null &&
          (completionExpiryAt === cache.minExpiryAt ||
            completionExpiryAt === cache.minCompletionExpiryAt))
      ) {
        cache = null
        return
      }
    }
    const { hookExpiryAt, completionExpiryAt } = entryExpiries(delta.nextEntry)
    if (hookExpiryAt >= cache.scannedAt) {
      cache.minExpiryAt = Math.min(cache.minExpiryAt, hookExpiryAt)
    }
    if (completionExpiryAt !== null && completionExpiryAt >= cache.scannedAt) {
      cache.minExpiryAt = Math.min(cache.minExpiryAt, completionExpiryAt)
      cache.minCompletionExpiryAt = Math.min(cache.minCompletionExpiryAt, completionExpiryAt)
    }
    cache.size =
      cache.size - delta.evictedEntries.length + (delta.replacedEntry === undefined ? 1 : 0)
    cache.entries = delta.nextEntries
  }

  const arm = (nextExpiryAt: number, now: number): void => {
    if (!Number.isFinite(nextExpiryAt)) {
      return
    }
    // Why: +1 ms ensures the timer fires strictly after the stale boundary,
    // so isExplicitAgentStatusFresh (which uses `<=`) flips to stale when the
    // timer runs. Without the +1, float/rounding could leave the entry "just
    // fresh enough" at the tick, delaying the epoch bump by one tick.
    timer = setTimeout(
      () => {
        timer = null
        deps.bumpEpochs()
        lastCheckedAt = Date.now()
        schedule()
      },
      nextExpiryAt - now + 1
    )
  }

  const scan = (statusEntries: Record<string, AgentStatusEntry>, now: number): void => {
    agentStatusFreshnessScanCounters.fullScans += 1
    const entries = Object.values(statusEntries)
    if (entries.length === 0) {
      cache = {
        entries: statusEntries,
        scannedAt: now,
        minExpiryAt: Infinity,
        minCompletionExpiryAt: Infinity,
        size: 0
      }
      lastCheckedAt = null
      return
    }
    let nextExpiryAt = Number.POSITIVE_INFINITY
    let nextCompletionExpiryAt = Number.POSITIVE_INFINITY
    let crossedCompletionDeadline = false
    // Why: skip entries already past the stale boundary — they each contribute
    // exactly one epoch bump at crossing, and rescheduling on them would spin
    // the timer forever because the bump doesn't clear them from the map
    // (retention is intentional so freshness-aware selectors can decay).
    //
    // Snapshot hydration can insert already-stale entries. Those need no
    // future timer: the setAgentStatus write already bumped the epoch, so
    // freshness-aware selectors can decay them immediately on that render.
    for (const entry of entries) {
      agentStatusFreshnessScanCounters.entryVisits += 1
      const { hookExpiryAt, completionExpiryAt } = entryExpiries(entry)
      if (hookExpiryAt >= now) {
        nextExpiryAt = Math.min(nextExpiryAt, hookExpiryAt)
      }
      // Completion and hook freshness have independent expiry times.
      if (completionExpiryAt !== null) {
        // Detect a missed completion expiry before a same-state update extends hook freshness.
        if (
          lastCheckedAt !== null &&
          completionExpiryAt >= lastCheckedAt &&
          completionExpiryAt < now
        ) {
          crossedCompletionDeadline = true
        }
        if (completionExpiryAt >= now) {
          nextExpiryAt = Math.min(nextExpiryAt, completionExpiryAt)
          nextCompletionExpiryAt = Math.min(nextCompletionExpiryAt, completionExpiryAt)
        }
      }
    }
    cache = {
      entries: statusEntries,
      scannedAt: now,
      minExpiryAt: nextExpiryAt,
      minCompletionExpiryAt: nextCompletionExpiryAt,
      size: entries.length
    }
    lastCheckedAt = now
    if (crossedCompletionDeadline) {
      deps.bumpEpochs()
    }
    arm(nextExpiryAt, now)
  }

  const schedule = (): void => {
    clear()
    const statusEntries = deps.getStatusEntries()
    const now = Date.now()
    // The cached minima answer only while they are still in the future: a minimum that has gone
    // past is exactly the case where the surviving candidates — and any crossing — need a rescan.
    if (
      cache !== null &&
      cache.entries === statusEntries &&
      cache.minExpiryAt >= now &&
      cache.minCompletionExpiryAt >= now
    ) {
      agentStatusFreshnessScanCounters.cachedScans += 1
      if (cache.size === 0) {
        lastCheckedAt = null
        return
      }
      lastCheckedAt = now
      arm(cache.minExpiryAt, now)
      return
    }
    scan(statusEntries, now)
  }

  const dispose = (): void => {
    clear()
    cache = null
    // Invalidate callbacks already queued by scheduleDeferred.
    deferredScheduleGeneration += 1
  }

  return { schedule, scheduleDeferred, noteLiveEntryDelta, dispose }
}
