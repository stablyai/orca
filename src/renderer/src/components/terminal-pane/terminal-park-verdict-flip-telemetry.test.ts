import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportBreadcrumbData } from '../../../../shared/crash-reporting'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS,
  TERMINAL_TAB_PARK_FLIP_COMMIT_COST,
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

// Derive burst damping from React’s 50-commit budget, independently of the slower breadcrumb notice threshold.
describe('burst damping threshold', () => {
  it('stays under React NESTED_UPDATE_LIMIT at the assumed commits-per-flip cost', () => {
    expect(TERMINAL_TAB_PARK_FLIP_BURST_LIMIT * TERMINAL_TAB_PARK_FLIP_COMMIT_COST).toBeLessThan(50)
    expect(TERMINAL_TAB_PARK_FLIP_BURST_LIMIT).toBeLessThan(TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT)
  })
})

describe('recordParkVerdictFlips', () => {
  it('stays silent for a stable verdict', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 100; i += 1) {
      observe({ records, parked: true, nowMs: 1_000 + i * 1_000 })
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(records.get(TAB)?.flips).toBe(0)
  })

  it('emits one burst breadcrumb once the verdict churns at render cadence', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        tabId: TAB,
        trigger: 'burst',
        flips: TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
        pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS
      })
    )
  })

  // Distinguish commit-speed burst protection from slower sustained-churn damping.
  it('separates a damped burst from slow churn', () => {
    const tightRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records: tightRecords, parked: i % 2 === 0, nowMs: 1_000 + i })
    }
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        trigger: 'burst',
        flips: TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
        elapsedMs: TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
        windowMs: TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS
      })
    )

    recordBreadcrumb.mockClear()

    const slowRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
      observe({ records: slowRecords, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
    }
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        trigger: 'window',
        flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT,
        elapsedMs: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT * SLOW_CHURN_STEP_MS,
        windowMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS
      })
    )
  })

  // Sustained remount/replay churn costs more than retaining the pane’s memory, even below React’s loop threshold.
  it('pins churn that is too slow to burst but reaches the notice limit', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
    }

    const noticeMs = 1_000 + TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT * SLOW_CHURN_STEP_MS
    expect(records.get(TAB)?.pinnedUntilMs).toBe(noticeMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        trigger: 'window',
        pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
        sustainedPinCount: 1
      })
    )
  })

  // Use observed 3193–5442 ms flip cadences. Twelve flips span eleven intervals, so the 60s window stops detecting beyond 5454.5 ms; the slowest observed cadence barely fits.
  describe('sustained field-cadence churn', () => {
    const FIELD_FLIP_INTERVAL_MS = 4_627
    const FIELD_SLOWEST_FLIP_INTERVAL_MS = 5_442
    const FIELD_CHURN_DURATION_MS = 47 * 60_000

    // Use a fixed 47-minute duration so cadences share the field report’s observation/crumb budget.
    function runFieldChurn(stepMs = FIELD_FLIP_INTERVAL_MS): {
      flips: number
      pinnedPasses: number
      crumbs: number
    } {
      const records = new Map<string, ParkVerdictFlipRecord>()
      const flips = Math.ceil(FIELD_CHURN_DURATION_MS / stepMs)
      let pinnedPasses = 0
      for (let i = 0; i < flips; i += 1) {
        const nowMs = 1_000 + i * stepMs
        observe({ records, parked: i % 2 === 0, nowMs })
        const { pinnedTabIds } = selectParkVerdictPinnedTabIds({
          records,
          tabIds: [TAB],
          nowMs
        })
        if (pinnedTabIds.size > 0) {
          pinnedPasses += 1
        }
      }
      return {
        flips,
        pinnedPasses,
        crumbs: recordBreadcrumb.mock.calls.filter(
          (call) => call[0] === 'terminal_park_verdict_churn'
        ).length
      }
    }

    // This open-loop harness forces flips even while pinned; feedback tests below cover suppressed flips and the engagement transition that can otherwise reset backoff. Compare user-visible verdict transitions, not pin duty cycle.
    it.each([
      ['fastest observed', 3_193, 0.5],
      ['median', FIELD_FLIP_INTERVAL_MS, 0.5],
      ['slowest observed', FIELD_SLOWEST_FLIP_INTERVAL_MS, 0.4]
    ])('damps %s field churn instead of letting it run all session', (_label, stepMs, floor) => {
      const { flips, pinnedPasses, crumbs } = runFieldChurn(stepMs)

      expect(pinnedPasses).toBeGreaterThan(flips * floor)
      expect(crumbs).toBeLessThan(20)
    })

    // Above 60s/11, sustained churn remains undetected; preserve the sharp 5450/5460 ms boundary so constants cannot silently move it.
    it('leaves churn slower than the window undamped', () => {
      const tooSlowMs =
        Math.ceil(TERMINAL_TAB_PARK_FLIP_WINDOW_MS / (TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT - 1)) + 1
      const { pinnedPasses, crumbs } = runFieldChurn(tooSlowMs)

      expect(pinnedPasses).toBe(0)
      expect(crumbs).toBe(0)
    })

    it('backs the pin off to the ceiling while the churn persists', () => {
      const records = new Map<string, ParkVerdictFlipRecord>()
      const flips = Math.ceil(FIELD_CHURN_DURATION_MS / FIELD_FLIP_INTERVAL_MS)
      for (let i = 0; i < flips; i += 1) {
        observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * FIELD_FLIP_INTERVAL_MS })
      }

      const pinnedForMs = recordBreadcrumb.mock.calls
        .filter((call) => call[0] === 'terminal_park_verdict_churn')
        .map((call) => pinDuration(call[1]))
      expect(pinnedForMs[0]).toBe(TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
      expect(pinnedForMs.at(-1)).toBe(TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS)
    })

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

    // Count rendered flips, the user-visible remount transitions; pin duty cycle is a different measure.
    it('cuts remounts against the undamped baseline', () => {
      const { remounts, crumbs } = runClosedLoopChurn(FIELD_FLIP_INTERVAL_MS)

      // Undamped, 20 min at 4627ms/flip is 260 remounts and 20 crumbs.
      expect(remounts).toBeLessThan(80)
      expect(crumbs).toBeLessThan(10)
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

    // Separate episodes must reset backoff; notice-limit counters alone cannot prove continued activity after hours of silence.
    it('does not accumulate across episodes hours apart', () => {
      const records = new Map<string, ParkVerdictFlipRecord>()
      let nowMs = 1_000
      let parked = false
      for (let episode = 0; episode < 4; episode += 1) {
        for (let i = 0; i <= TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT; i += 1) {
          parked = !parked
          observe({ records, parked, nowMs })
          nowMs += SLOW_CHURN_STEP_MS
        }
        nowMs += 6 * 60 * 60 * 1_000
      }

      const pinnedForMs = recordBreadcrumb.mock.calls
        .filter((call) => call[0] === 'terminal_park_verdict_churn')
        .map((call) => pinDuration(call[1]))
      expect(pinnedForMs).toHaveLength(4)
      expect(pinnedForMs.every((ms) => ms === TERMINAL_TAB_PARK_FLIP_WINDOW_MS)).toBe(true)
    })

    // Slow cadences can close windows at 11/12 without easing churn; backoff must still climb instead of resetting.
    it.each([4_800, 5_000, FIELD_SLOWEST_FLIP_INTERVAL_MS])(
      'still backs off above the alignment cliff at %ims per flip',
      (stepMs) => {
        runFieldChurn(stepMs)

        const pinnedForMs = recordBreadcrumb.mock.calls
          .filter((call) => call[0] === 'terminal_park_verdict_churn')
          .map((call) => pinDuration(call[1]))
        expect(Math.max(...pinnedForMs)).toBeGreaterThan(TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
      }
    )

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

  // This full-quiet gap proves reset exists; only the sparse-churn test distinguishes below-limit reset from quiet reset.
  it('clears the back-off when a window closes below the notice limit', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
    }
    expect(records.get(TAB)?.sustainedPinCount).toBe(1)

    // A single later flip closes a genuinely below-threshold window.
    const nextWindowMs = 1_000 + TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS * 2
    observe({ records, parked: false, nowMs: nextWindowMs })
    observe({ records, parked: true, nowMs: nextWindowMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS + 1 })

    expect(records.get(TAB)?.sustainedPinCount).toBe(0)
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

  it('re-arms after the window elapses', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)

    const laterMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: laterMs + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(2)
  })

  // Backward clock jumps must not freeze telemetry windows.
  it('treats a backwards clock jump as a fresh window', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 10_000_000 })
    observe({ records, parked: false, nowMs: 1_000 })

    expect(records.get(TAB)?.windowStartMs).toBe(1_000)
    expect(records.get(TAB)?.flips).toBe(1)
  })

  // Include equality at the deadline or notices slip by a full period.
  it('treats an exactly-elapsed window as expired', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })
    observe({ records, parked: false, nowMs: 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS })

    expect(records.get(TAB)?.windowStartMs).toBe(1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
    expect(records.get(TAB)?.flips).toBe(1)
  })

  it('honours the window, notice, burst-window and burst-limit overrides', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 10; i += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB]),
        nextParkedTabIds: i % 2 === 0 ? new Set([TAB]) : new Set(),
        nowMs: 1_000 + i * 100,
        flipWindowMs: 5_000,
        noticeLimit: 3,
        burstWindowMs: 10,
        burstLimit: 2
      })
    }

    // 100ms steps exceed the 10ms burst window, isolating sustained notice-limit behavior.
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window', flips: 3, windowMs: 5_000 })
    )
  })

  it('keeps per-tab windows and notices independent', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const other = 'tab-2'
    for (let i = 0; i < 40; i += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB, other]),
        // Why: TAB churns every call, other stays parked throughout.
        nextParkedTabIds: i % 2 === 0 ? new Set([TAB, other]) : new Set([other]),
        nowMs: 1_000 + i * 10
      })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ tabId: TAB })
    )
    expect(records.get(other)?.flips).toBe(0)
  })

  it('drops records for tabs that no longer exist', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })

    recordParkVerdictFlips({
      records,
      liveTabIds: new Set(),
      nextParkedTabIds: new Set(),
      nowMs: 2_000
    })

    expect(records.size).toBe(0)
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

  it('does not pin a stable verdict', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })

    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: 2_000 })).toBeNull()
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: 'missing', nowMs: 2_000 })).toBeNull()
  })

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

  it('still reports slow churn after a pin lapses', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }
    recordBreadcrumb.mockClear()

    // Slow steps isolate sustained churn; a lapsed pin cannot silence its next notice.
    const afterPinMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i <= TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: afterPinMs + i * SLOW_CHURN_STEP_MS })
    }

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window' })
    )
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
