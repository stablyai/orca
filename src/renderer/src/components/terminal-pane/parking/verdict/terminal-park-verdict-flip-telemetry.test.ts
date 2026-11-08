import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportBreadcrumbData } from '../../../../../../shared/crash-reporting'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS,
  TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT,
  TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS,
  TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
  getParkVerdictUnparkPinUntilMs,
  recordParkVerdictFlips,
  selectParkVerdictPinnedTabIds,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'

const recordBreadcrumb = vi.fn<(name: string, data?: CrashReportBreadcrumbData) => void>()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: CrashReportBreadcrumbData) =>
    recordBreadcrumb(name, data)
}))

function pinDuration(data?: CrashReportBreadcrumbData): number {
  if (typeof data?.pinnedForMs !== 'number') {
    throw new Error('Missing numeric pin duration')
  }
  return data.pinnedForMs
}

const TAB = 'tab-1'
/** Slower than the burst window, so only the notice limit can fire. */
const SLOW_CHURN_STEP_MS = TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS * 4

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

describe('recordParkVerdictFlips', () => {
  // Use observed 3193–5442 ms flip cadences. Twelve flips span eleven intervals, so the 60s window stops detecting beyond 5454.5 ms; the slowest observed cadence barely fits.
  describe('sustained field-cadence churn', () => {
    const FIELD_FLIP_INTERVAL_MS = 4_627

    // Feed pins into the next rendered verdict: pinned tabs stop recording flips, so backoff must survive silence caused by its own damping.
    function runClosedLoopChurn(stepMs: number, durationMs = 20 * 60_000) {
      const records = new Map<string, ParkVerdictFlipRecord>()
      const passes = Math.ceil(durationMs / stepMs)
      let pinned = new Set<string>()
      let remounts = 0
      let previouslyParked = false
      for (let i = 0; i < passes; i += 1) {
        const nowMs = 1_000 + i * stepMs
        const candidateParked = i % 2 === 0
        const renderedParked = candidateParked && !pinned.has(TAB)
        recordParkVerdictFlips({
          records,
          liveTabIds: new Set([TAB]),
          nextParkedTabIds: new Set(renderedParked ? [TAB] : []),
          nowMs
        })
        pinned = selectParkVerdictPinnedTabIds({ records, tabIds: [TAB], nowMs }).pinnedTabIds
        if (renderedParked !== previouslyParked) {
          remounts += 1
          previouslyParked = renderedParked
        }
      }
      const crumbs = recordBreadcrumb.mock.calls.filter(
        (call) => call[0] === 'terminal_park_verdict_churn'
      )
      return {
        remounts,
        crumbs: crumbs.length,
        pinnedForMs: crumbs.map((call) => pinDuration(call[1]))
      }
    }

    it('reaches the ceiling under the real pin feedback loop', () => {
      const { pinnedForMs } = runClosedLoopChurn(FIELD_FLIP_INTERVAL_MS)

      // Assert every backoff step; wrong bases or early resets can pass endpoints alone.
      expect(pinnedForMs.length).toBeGreaterThan(3)
      expect(pinnedForMs.slice(0, 4)).toEqual([
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2,
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 4,
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 8
      ])
      expect(pinnedForMs.at(-1)).toBe(TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS)
    })

    // Apply pin engagement in the same commit: its own verdict flip must preserve the future deadline instead of resetting backoff a window early.
    it('keeps the back-off when the pin engagement is itself a flip', () => {
      const records = new Map<string, ParkVerdictFlipRecord>()
      const stepMs = 5_000
      let pinned = new Set<string>()
      for (let i = 0; i < 400; i += 1) {
        const nowMs = 1_000 + i * stepMs
        const candidateParked = i % 2 === 0
        recordParkVerdictFlips({
          records,
          liveTabIds: new Set([TAB]),
          nextParkedTabIds: new Set(candidateParked && !pinned.has(TAB) ? [TAB] : []),
          nowMs
        })
        pinned = selectParkVerdictPinnedTabIds({ records, tabIds: [TAB], nowMs }).pinnedTabIds
        // The re-render the pin itself causes, in the same commit cascade.
        recordParkVerdictFlips({
          records,
          liveTabIds: new Set([TAB]),
          nextParkedTabIds: new Set(candidateParked && !pinned.has(TAB) ? [TAB] : []),
          nowMs
        })
      }

      const pinnedForMs = recordBreadcrumb.mock.calls
        .filter((call) => call[0] === 'terminal_park_verdict_churn')
        .map((call) => pinDuration(call[1]))
      expect(Math.max(...pinnedForMs)).toBe(TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS)
    })

    // Real silence must reset backoff so launch churn cannot retain a ceiling pin hours later.
    it('starts over at one window after a quiet window', () => {
      const records = new Map<string, ParkVerdictFlipRecord>()
      for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
        observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
      }
      expect(records.get(TAB)?.sustainedPinCount).toBe(1)

      const quietMs = 1_000 + TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS * 4
      observe({ records, parked: true, nowMs: quietMs })
      expect(records.get(TAB)?.sustainedPinCount).toBe(0)

      recordBreadcrumb.mockClear()
      for (let i = 1; i <= TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT; i += 1) {
        observe({ records, parked: i % 2 === 0, nowMs: quietMs + i * SLOW_CHURN_STEP_MS })
      }
      expect(recordBreadcrumb).toHaveBeenCalledWith(
        'terminal_park_verdict_churn',
        expect.objectContaining({
          pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
          sustainedPinCount: 1
        })
      )
    })
  })

  // One flip/20s is below-threshold but never fully quiet; only eased-churn reset can release backoff instead of retaining the ceiling indefinitely.
  it('clears the back-off under churn that eased but never stopped', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    let nowMs = 1_000
    let parked = false
    for (let i = 0; i <= TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT; i += 1) {
      parked = !parked
      observe({ records, parked, nowMs })
      nowMs += SLOW_CHURN_STEP_MS
    }
    expect(records.get(TAB)?.sustainedPinCount).toBe(1)

    nowMs = (records.get(TAB)?.pinnedUntilMs ?? nowMs) + 1_000
    for (let i = 0; i < 12; i += 1) {
      parked = !parked
      observe({ records, parked, nowMs })
      nowMs += 20_000
    }

    expect(records.get(TAB)?.sustainedPinCount).toBe(0)
  })
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
  it('reports the pin deadline one window out, then re-arms', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const pinnedAtMs = churnToBurst(records)
    const pinUntilMs = pinnedAtMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS

    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: pinnedAtMs + 1 })).toBe(
      pinUntilMs
    )
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: pinUntilMs })).toBeNull()
    expect(records.get(TAB)?.flips).toBe(0)
    expect(records.get(TAB)?.burstFlips).toBe(0)

    recordBreadcrumb.mockClear()
    churnToBurst(records, pinUntilMs)
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: pinUntilMs + 1 })).not.toBe(
      null
    )
  })

  // Why: a backwards clock jump must release the pin, not strand it for a window.
  it('releases the pin when the clock jumps backwards', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    churnToBurst(records)

    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: 5 })).toBeNull()
  })

  // Notice windows lapse before pin expiry; resetting them must not release live damping.
  it('survives a notice-window expiry that lands mid-pin', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const pinnedAtMs = churnToBurst(records)
    const pinUntilMs = pinnedAtMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS
    const windowLapseMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS

    // Flip after notice-window expiry but before pin expiry.
    expect(windowLapseMs).toBeLessThan(pinUntilMs)
    observe({ records, parked: true, nowMs: windowLapseMs })

    expect(records.get(TAB)?.flips).toBe(1)
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: windowLapseMs })).toBe(
      pinUntilMs
    )
  })
})

// Tabs can leave the candidate set without a deadline read; expired pins must stop suppressing telemetry independently.
describe('expired pins stop gating breadcrumbs', () => {
  it('re-arms damping and notices without a getParkVerdictUnparkPinUntilMs call', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenLastCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'burst' })
    )

    // Churn resumes past the pin deadline; the pin was never read back.
    const afterPinMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: afterPinMs + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(2)
    expect(recordBreadcrumb).toHaveBeenLastCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'burst' })
    )
    expect(records.get(TAB)?.pinnedUntilMs).toBeGreaterThan(afterPinMs)
  })

  // Read/expire pins for every rendered tab, including drivers outside cold-park candidates (#15136).
  it('selects and expires pins for tabs the cold-park selector never proposed', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }

    const pinned = selectParkVerdictPinnedTabIds({ records, tabIds: [TAB], nowMs: 1_500 })
    expect(pinned.pinnedTabIds).toEqual(new Set([TAB]))
    expect(pinned.earliestPinExpiryMs).toBe(records.get(TAB)?.pinnedUntilMs)

    // Past the deadline the pin lapses in place, so damping never latches on.
    const lapsed = selectParkVerdictPinnedTabIds({
      records,
      tabIds: [TAB],
      nowMs: 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 3
    })
    expect(lapsed.pinnedTabIds.size).toBe(0)
    expect(lapsed.earliestPinExpiryMs).toBeNull()
    expect(records.get(TAB)?.pinnedUntilMs).toBeNull()
  })
})
