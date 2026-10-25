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

/** Report live-map changes against previousEntries for incremental minima; unreported replacements invalidate cache rather than corrupt it. */
export type FreshnessLiveEntryDelta = {
  previousEntries: Record<string, AgentStatusEntry>
  nextEntries: Record<string, AgentStatusEntry>
  nextEntry: AgentStatusEntry
  replacedEntry: AgentStatusEntry | undefined
  evictedEntries: readonly AgentStatusEntry[]
}

export type FreshnessScheduler = {
  schedule: () => void
  /** Keep microtask slots for ordering but scan only the newest deferred request. */
  scheduleDeferred: () => void
  noteLiveEntryDelta: (delta: FreshnessLiveEntryDelta) => void
  /** Test stores dispose timers per case; production singleton lives until process exit. */
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

/** Minima include only candidates future at scannedAt; fixed expired candidates never reenter because time advances. */
type FreshnessScanCache = {
  entries: Record<string, AgentStatusEntry>
  scannedAt: number
  minExpiryAt: number
  minCompletionExpiryAt: number
  size: number
}

export function createFreshnessScheduler(deps: FreshnessSchedulerDeps): FreshnessScheduler {
  // Use fake timers or dispose in tests to avoid leaking real 30-minute timers.
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
    // Fire +1ms past <= freshness boundary so rounding cannot leave status fresh until another tick.
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
    // Skip expired retained rows or rescheduling spins forever. Already-stale hydration needs no timer: setAgentStatus already bumped epoch for consumers to decay it.
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
    // Past minima cannot answer cached freshness; rescan surviving candidates and crossings.
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
