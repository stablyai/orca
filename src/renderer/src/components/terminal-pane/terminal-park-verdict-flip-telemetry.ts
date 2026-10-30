/** Damp rendered park oscillation by retaining panes: bursts threaten React #185, sustained flips repeatedly remount/replay. This bounds churn without fixing its unknown driver; apply pins to all rendered tabs, including non-cold-park drivers. Retention force-park bypasses sustained pins, never burst protection. */
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { REACT_NESTED_UPDATE_LIMIT } from '../../../../shared/react-update-depth-attribution'

export const TERMINAL_TAB_PARK_FLIP_WINDOW_MS = 60_000
/** Flips per window that no sane park policy should reach. */
export const TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT = 12
/** Consecutive sustained notices double pin duration up to the ceiling; burst pins stay one window. Reset only after a full quiet window past the pin deadline. */
export const TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS = 8 * TERMINAL_TAB_PARK_FLIP_WINDOW_MS

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
  /** Set when flip churn engaged damping; the verdict stays unparked until then. */
  pinnedUntilMs?: number | null
  pinTrigger?: 'burst' | 'window'
  /** Consecutive notice-limit windows; backs the pin off for churn that persists. */
  sustainedPinCount?: number
  /** Latest flip or pin deadline, whichever is later: pins suppress their own flips, so backoff cannot measure quiet from flip time alone. Ceiling pins need roughly nine minutes of silence, not one. */
  lastFlipMs: number
}

// Notice windows can lapse mid-pin; preserve the deadline so reset cannot release damping early.
function resetFlipWindows(record: ParkVerdictFlipRecord, nowMs: number): void {
  record.windowStartMs = nowMs
  record.flips = 0
  record.notified = false
  record.burstStartMs = nowMs
  record.burstFlips = 0
}

/** Require a full quiet window since flip/pin deadline; windowStart is stale during pins and tautologically old on window-closing flips. */
function hasBeenQuietForAWindow(
  record: ParkVerdictFlipRecord,
  nowMs: number,
  flipWindowMs: number
): boolean {
  return nowMs - record.lastFlipMs >= flipWindowMs
}

/** Use half the notice limit: slower ongoing churn can close at 11/12 after pin realignment, which must not falsely reset backoff. */
function easedFlipCount(noticeLimit: number): number {
  return Math.ceil(noticeLimit / 2)
}

// Expire pins even after tabs leave candidate sets; absent deadline reads cannot prolong damping or mute telemetry.
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
    record.pinTrigger = undefined
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
  sustainedPinMaxMs?: number
  allowSustainedPin?: boolean
}): void {
  const {
    records,
    liveTabIds,
    nextParkedTabIds,
    nowMs,
    flipWindowMs = TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
    noticeLimit = TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT,
    burstWindowMs = TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS,
    burstLimit = TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
    sustainedPinMaxMs = TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS,
    allowSustainedPin = true
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
        pinnedUntilMs: null,
        lastFlipMs: nowMs
      })
      continue
    }
    // Retention eviction must also release pins earned before the force-park.
    if (!allowSustainedPin && record.pinTrigger === 'window') {
      resetFlipWindows(record, nowMs)
      record.pinnedUntilMs = null
      record.pinTrigger = undefined
      record.sustainedPinCount = 0
      record.lastFlipMs = nowMs
    }
    if (parked === record.parked) {
      // Reset on quiet passes too, or stopped churn retains backoff indefinitely. Future pin deadlines already fail the quiet-window test.
      if (record.sustainedPinCount && hasBeenQuietForAWindow(record, nowMs, flipWindowMs)) {
        record.sustainedPinCount = 0
      }
      continue
    }

    // NTP/sleep can move Date.now backwards; restart out-of-range windows instead of trusting the delta.
    const elapsedMs = nowMs - record.windowStartMs
    if (elapsedMs >= flipWindowMs || elapsedMs < 0) {
      // Use quiet evidence: 11/12 windows may still churn, while exact-limit counters can remain after hours of silence; neither count alone proves reset eligibility.
      if (
        record.flips < easedFlipCount(noticeLimit) ||
        hasBeenQuietForAWindow(record, nowMs, flipWindowMs)
      ) {
        record.sustainedPinCount = 0
      }
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
    // Pin engagement itself flips the rendered verdict; keep the maximum deadline so that flip cannot clear backoff before damping ends.
    record.lastFlipMs = Math.max(nowMs, record.pinnedUntilMs ?? 0)

    if (!isParkVerdictPinLive(record, nowMs) && record.burstFlips >= burstLimit) {
      record.pinnedUntilMs = nowMs + flipWindowMs
      record.pinTrigger = 'burst'
      record.lastFlipMs = record.pinnedUntilMs
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
    // Suppress duplicate sustained crumbs while a live burst pin already reported this window.
    if (!isParkVerdictPinLive(record, nowMs) && !record.notified && record.flips >= noticeLimit) {
      record.notified = true
      // Notice-limit churn must damp too: 3–5s flips avoid bursts but repeatedly remount panes for minutes.
      let pinData: { pinnedForMs: number; sustainedPinCount: number } | undefined
      if (allowSustainedPin) {
        const sustainedPinCount = (record.sustainedPinCount ?? 0) + 1
        const pinnedForMs = Math.min(flipWindowMs * 2 ** (sustainedPinCount - 1), sustainedPinMaxMs)
        record.sustainedPinCount = sustainedPinCount
        record.pinnedUntilMs = nowMs + pinnedForMs
        record.pinTrigger = 'window'
        record.lastFlipMs = record.pinnedUntilMs
        pinData = { pinnedForMs, sustainedPinCount }
      }
      // Count is always noticeLimit here; elapsed time distinguishes slow churn from burst-speed flips.
      recordRendererCrashBreadcrumb('terminal_park_verdict_churn', {
        tabId,
        trigger: 'window',
        flips: record.flips,
        elapsedMs: nowMs - record.windowStartMs,
        windowMs: flipWindowMs,
        ...pinData
      })
    }
  }
}

export type ParkVerdictPinSelection = {
  pinnedTabIds: Set<string>
  /** Earliest live pin deadline, so a caller can wake exactly when damping lapses. */
  earliestPinExpiryMs: number | null
}

/** Expire rendered-verdict pins for every live tab, including worktree/activation drivers outside cold candidates; cold-only reads would mute telemetry without damping their churn. */
export function selectParkVerdictPinnedTabIds(args: {
  records: Map<string, ParkVerdictFlipRecord>
  tabIds: Iterable<string>
  nowMs: number
}): ParkVerdictPinSelection {
  const pinnedTabIds = new Set<string>()
  let earliestPinExpiryMs: number | null = null
  for (const tabId of args.tabIds) {
    const pinnedUntilMs = getParkVerdictUnparkPinUntilMs({
      records: args.records,
      tabId,
      nowMs: args.nowMs
    })
    if (pinnedUntilMs === null) {
      continue
    }
    pinnedTabIds.add(tabId)
    earliestPinExpiryMs =
      earliestPinExpiryMs === null ? pinnedUntilMs : Math.min(earliestPinExpiryMs, pinnedUntilMs)
  }
  return { pinnedTabIds, earliestPinExpiryMs }
}
