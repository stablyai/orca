/**
 * Cold-park verdict telemetry and a safe-side circuit breaker.
 * Field breadcrumbs prove render-cadence flips, but not which eligibility input
 * oscillates; burst damping keeps the pane mounted before React reaches #185.
 *
 * Scope: flips are counted on the rendered verdict, but the pin can only
 * subtract from the cold-park candidate set. Churn driven by the other parked
 * inputs (forced parking, portal ownership, deferred activation mounts) is
 * observed and breadcrumbed, not damped — read a repeating `burst` crumb for
 * one tab as "damping did not reach the oscillating input".
 */
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { REACT_NESTED_UPDATE_LIMIT } from '../../../../shared/react-update-depth-attribution'

export const TERMINAL_TAB_PARK_FLIP_WINDOW_MS = 60_000
/** Flips per window that no sane park policy should reach. Breadcrumb only. */
export const TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT = 12

/** Measured upper bound after the passive-effect pin engages. */
const PARK_PIN_SETTLE_COMMITS = 6
/** Worst-case commits from pane, watcher, and store work per verdict flip. */
export const TERMINAL_TAB_PARK_FLIP_COMMIT_COST = 12
/** Pin threshold derived from React's remaining commit budget. */
export const TERMINAL_TAB_PARK_FLIP_BURST_LIMIT = Math.max(
  2,
  Math.floor(
    (REACT_NESTED_UPDATE_LIMIT - PARK_PIN_SETTLE_COMMITS) / TERMINAL_TAB_PARK_FLIP_COMMIT_COST
  )
)
/** Honest cold parking cannot round-trip inside this horizon. */
export const TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS = 1_000

export type ParkVerdictFlipRecord = {
  parked: boolean
  windowStartMs: number
  flips: number
  notified: boolean
  burstStartMs: number
  burstFlips: number
  /** Set when a flip burst engaged damping; the verdict stays unparked until then. */
  pinnedUntilMs?: number | null
}

// Why it leaves pinnedUntilMs alone: the notice window is 60s from the first
// flip, so it lapses mid-pin; clearing here would release damping early.
function resetFlipWindows(record: ParkVerdictFlipRecord, nowMs: number): void {
  record.windowStartMs = nowMs
  record.flips = 0
  record.notified = false
  record.burstStartMs = nowMs
  record.burstFlips = 0
}

// Why liveness and not presence: a tab pinned while cold-park-eligible can stop
// being a candidate before its deadline, and nothing would consult it again. An
// expired pin must stop damping and stop gating breadcrumbs on its own.
function isParkVerdictPinLive(record: ParkVerdictFlipRecord, nowMs: number): boolean {
  return record.pinnedUntilMs != null && nowMs < record.pinnedUntilMs
}

/** Returns the safe-side pin deadline and re-arms an expired window. */
export function getParkVerdictUnparkPinUntilMs(args: {
  records: Map<string, ParkVerdictFlipRecord>
  tabId: string
  nowMs: number
}): number | null {
  const record = args.records.get(args.tabId)
  if (record?.pinnedUntilMs == null) {
    return null
  }
  if (!isParkVerdictPinLive(record, args.nowMs) || args.nowMs < record.windowStartMs) {
    resetFlipWindows(record, args.nowMs)
    record.pinnedUntilMs = null
    return null
  }
  return record.pinnedUntilMs
}

/** Records park-verdict churn per tab; damps bursts and breadcrumbs the rest. */
export function recordParkVerdictFlips(args: {
  records: Map<string, ParkVerdictFlipRecord>
  liveTabIds: ReadonlySet<string>
  nextParkedTabIds: ReadonlySet<string>
  nowMs: number
  flipWindowMs?: number
  noticeLimit?: number
  burstWindowMs?: number
  burstLimit?: number
}): void {
  const {
    records,
    liveTabIds,
    nextParkedTabIds,
    nowMs,
    flipWindowMs = TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
    noticeLimit = TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT,
    burstWindowMs = TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS,
    burstLimit = TERMINAL_TAB_PARK_FLIP_BURST_LIMIT
  } = args

  for (const tabId of Array.from(records.keys())) {
    if (!liveTabIds.has(tabId)) {
      records.delete(tabId)
    }
  }

  for (const tabId of liveTabIds) {
    const parked = nextParkedTabIds.has(tabId)
    const record = records.get(tabId)

    if (!record) {
      records.set(tabId, {
        parked,
        windowStartMs: nowMs,
        flips: 0,
        notified: false,
        burstStartMs: nowMs,
        burstFlips: 0,
        pinnedUntilMs: null
      })
      continue
    }
    if (parked === record.parked) {
      continue
    }

    // Why: Date.now() jumps backwards on NTP/sleep-wake; treat any out-of-range
    // elapsed value as a fresh window rather than trusting the delta.
    const elapsedMs = nowMs - record.windowStartMs
    if (elapsedMs >= flipWindowMs || elapsedMs < 0) {
      resetFlipWindows(record, nowMs)
    }
    const burstElapsedMs = nowMs - record.burstStartMs
    if (burstElapsedMs >= burstWindowMs || burstElapsedMs < 0) {
      record.burstStartMs = nowMs
      record.burstFlips = 0
    }

    record.parked = parked
    record.flips += 1
    record.burstFlips += 1

    if (!isParkVerdictPinLive(record, nowMs) && record.burstFlips >= burstLimit) {
      record.pinnedUntilMs = nowMs + flipWindowMs
      recordRendererCrashBreadcrumb('terminal_park_verdict_churn', {
        tabId,
        trigger: 'burst',
        flips: record.burstFlips,
        elapsedMs: nowMs - record.burstStartMs,
        windowMs: burstWindowMs,
        pinnedForMs: flipWindowMs
      })
      continue
    }
    // Why a live pin gates this: the burst crumb already reported the same
    // window, so a second crumb would only double the volume the notice limit
    // exists to keep down.
    if (!isParkVerdictPinLive(record, nowMs) && !record.notified && record.flips >= noticeLimit) {
      record.notified = true
      // Why: flips is always exactly noticeLimit here, so elapsedMs is the only
      // field that separates slow churn from a burst the damping already caught.
      recordRendererCrashBreadcrumb('terminal_park_verdict_churn', {
        tabId,
        trigger: 'window',
        flips: record.flips,
        elapsedMs: nowMs - record.windowStartMs,
        windowMs: flipWindowMs
      })
    }
  }
}
