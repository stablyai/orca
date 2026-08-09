/** Observes rendered cold-park verdict churn without changing parking policy. */
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

export const TERMINAL_TAB_PARK_FLIP_WINDOW_MS = 60_000
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
      recordRendererCrashBreadcrumb('terminal_park_verdict_churn', {
        tabId,
        flips: record.flips,
        elapsedMs: nowMs - record.windowStartMs,
        windowMs: flipWindowMs
      })
    }
  }
}
