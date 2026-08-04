/**
 * Cold-park verdict flip telemetry (observation only — changes no verdict).
 *
 * Why: crash cluster C5 (React #185 in TerminalPaneOverlayLayer) points at a
 * setState loop in the cold-parking passive effect, but no park-flip loop has
 * been reproduced, and the capture-coverage oscillator that looked like the
 * cause provably self-terminates (the unmount capture is never cleared on
 * remount, so coverage pins rather than alternates). This records whether the
 * rendered park verdict actually churns in the field. Deliberately no damping:
 * guarding a loop nobody has shown can run would add a park delay and a
 * retention path for no demonstrated benefit.
 *
 * Reading the signal: breadcrumbs also emit a durable `renderer.breadcrumb`
 * trace span, so this is queryable without waiting for a crash bundle. `flips`
 * always equals the notice limit — `elapsedMs` is what separates a render loop
 * from slow churn. Silence only rules out churn at effect cadence; a same-tick
 * cascade can crash before the limit accumulates. If it fires, start with the
 * candidate selection in terminal-hidden-view-parking.ts.
 */
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

export const TERMINAL_TAB_PARK_FLIP_WINDOW_MS = 60_000
/** Flips per window that no sane park policy should reach. */
export const TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT = 12

export type ParkVerdictFlipRecord = {
  parked: boolean
  windowStartMs: number
  flips: number
  notified: boolean
}

/** Records park-verdict churn per tab; emits one breadcrumb per window. */
export function recordParkVerdictFlips(args: {
  records: Map<string, ParkVerdictFlipRecord>
  liveTabIds: ReadonlySet<string>
  nextParkedTabIds: ReadonlySet<string>
  nowMs: number
  flipWindowMs?: number
  noticeLimit?: number
}): void {
  const {
    records,
    liveTabIds,
    nextParkedTabIds,
    nowMs,
    flipWindowMs = TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
    noticeLimit = TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT
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
      records.set(tabId, { parked, windowStartMs: nowMs, flips: 0, notified: false })
      continue
    }
    if (parked === record.parked) {
      continue
    }

    // Why: Date.now() jumps backwards on NTP/sleep-wake; treat any out-of-range
    // elapsed value as a fresh window rather than trusting the delta.
    const elapsedMs = nowMs - record.windowStartMs
    if (elapsedMs >= flipWindowMs || elapsedMs < 0) {
      record.windowStartMs = nowMs
      record.flips = 0
      record.notified = false
    }

    record.parked = parked
    record.flips += 1

    if (!record.notified && record.flips >= noticeLimit) {
      record.notified = true
      // Why: flips is always exactly noticeLimit here, so elapsedMs is the only
      // field that separates a render loop from slow benign churn.
      recordRendererCrashBreadcrumb('terminal_park_verdict_churn', {
        tabId,
        flips: record.flips,
        elapsedMs: nowMs - record.windowStartMs,
        windowMs: flipWindowMs
      })
    }
  }
}
