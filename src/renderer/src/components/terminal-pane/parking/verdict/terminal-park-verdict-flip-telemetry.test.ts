import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportBreadcrumbData } from '../../../../../../shared/crash-reporting'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  getParkVerdictUnparkPinUntilMs,
  recordParkVerdictFlips,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'

const recordBreadcrumb = vi.fn<(name: string, data?: CrashReportBreadcrumbData) => void>()
vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: CrashReportBreadcrumbData) =>
    recordBreadcrumb(name, data)
}))

const TAB = 'tab-1'
/** Slower than the burst window, so only the notice limit can fire. */

function observe(args: {
  records: Map<string, ParkVerdictFlipRecord>
  parked: boolean
  nowMs: number
  liveTabIds?: ReadonlySet<string>
}): void {
  recordParkVerdictFlips({
    records: args.records,
    liveTabIds: args.liveTabIds ?? new Set([TAB]),
    nextParkedTabIds: args.parked ? new Set([TAB]) : new Set(),
    nowMs: args.nowMs
  })
}

beforeEach(() => {
  recordBreadcrumb.mockClear()
})

describe('getParkVerdictUnparkPinUntilMs', () => {
  function churnToBurst(records: Map<string, ParkVerdictFlipRecord>, startMs = 1_000): number {
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: startMs + i * 10 })
    }
    // The first observation only seeds the record, so flip N lands one step later.
    return startMs + TERMINAL_TAB_PARK_FLIP_BURST_LIMIT * 10
  }

  // Return the deadline so the effect can schedule its only wakeup after damping stops flips.

  // Why: a backwards clock jump must release the pin, not strand it for a window.
  it('releases the pin when the clock jumps backwards', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    churnToBurst(records)

    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: 5 })).toBeNull()
  })

  // Notice windows lapse before pin expiry; resetting them must not release live damping.
})

// Tabs can leave the candidate set without a deadline read; expired pins must stop suppressing telemetry independently.
