import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

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

// Why asserted: the whole point of the burst trigger is that it is derived from
// React's 50-commit bail, not copied from the breadcrumb notice limit. If the
// two ever converge again the damping stops firing before React throws #185.
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

  // Why: the two triggers answer different questions — 'burst' means damping
  // engaged before React could bail, 'window' means churn too slow to loop.
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

  // Why this replaced "does not pin churn spread past the burst window": that
  // rule read the pin as purely a React #185 guard, so slow churn was left to
  // run rather than spend a mounted pane's memory on it. The field disagreed —
  // slow churn remounts the pane every ~3.8s for as long as it lasts, and a
  // remount re-establishes a remote terminal. Memory is the cheaper side.
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

  // Why these cadences and not round numbers: they are the field's. Bundle
  // Nz4kzIG_NwLd8KObgjJDKA (v1.4.201, win32) carries 52 churn crumbs, and they
  // are TWO unrelated episodes in two launches, not one run:
  //   L3 (09-14 00:53) 35 crumbs, 1 tab, 46.9 min, 34 window + 1 burst
  //   L4 (09-14 17:07) 17 crumbs, 4 tabs,  8.9 min, 17 window + 0 burst
  // The user filed from L4, 12.3 min after its churn had already stopped.
  //
  // Per-flip cadence is elapsedMs / (NOTICE_LIMIT - 1), NOT / NOTICE_LIMIT: the
  // window opens ON a flip (resetFlipWindows then `flips += 1`), so the 12th
  // flip sits 11 intervals later. L3 runs 3197/4627/5442 ms per flip
  // (min/median/max); L4 runs 3193/3203/5014.
  //
  // The slow end is where this matters. The limit needs 12 flips inside 60s, so
  // it is unreachable past 60s/11 = 5454.5 ms per flip — and the field's slowest
  // observed episode sits 12.7 ms inside that, not comfortably clear of it. The
  // cadences below therefore span the real range INCLUDING that edge, and the
  // edge case asserts the weaker damping that actually happens there.
  describe('sustained field-cadence churn', () => {
    const FIELD_FLIP_INTERVAL_MS = 4_627
    const FIELD_SLOWEST_FLIP_INTERVAL_MS = 5_442
    const FIELD_CHURN_DURATION_MS = 47 * 60_000

    // Fixed duration rather than a fixed flip count, so every cadence covers
    // the same 47 minutes the field bundle spans and the crumb budget compares.
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

    // Two harnesses, and the difference between them matters.
    //
    // This one is OPEN-LOOP: it drives the parked flag unconditionally. The real
    // hook subtracts pinned tabs from the rendered verdict, so a pinned tab
    // records no flip at all — and engaging the pin is itself a transition, so a
    // flip lands INSIDE the live pin. Three successive defects in this file were
    // invisible here and visible the moment the pin was fed back. Keep it as a
    // cheap regression guard; read 'keeps the back-off when the pin engagement
    // is itself a flip' for behaviour.
    //
    // The user-visible quantity is verdict transitions — two per mount/unmount
    // cycle — measured over 47 simulated minutes with the pin applied in the
    // same commit cascade as the flip that caused it:
    //
    //   per flip   transitions before -> after   ceiling reached
    //   3193 ms    884 -> 96   (9.2x fewer)      8x
    //   4627 ms    610 -> 96   (6.4x fewer)      8x
    //   4800 ms    588 -> 96   (6.1x fewer)      8x
    //   5000 ms    564 -> 126  (4.5x fewer)      8x
    //   5442 ms    519 -> 156  (3.3x fewer)      8x
    //
    // The slow end is weaker but no longer collapses: reaching 12 flips takes 11
    // intervals, so past ~4.7s per flip each window only barely makes the limit
    // and damping engages later. It still reaches the ceiling everywhere.
    it.each([
      ['fastest observed', 3_193, 0.5],
      ['median', FIELD_FLIP_INTERVAL_MS, 0.5],
      ['slowest observed', FIELD_SLOWEST_FLIP_INTERVAL_MS, 0.4]
    ])('damps %s field churn instead of letting it run all session', (_label, stepMs, floor) => {
      const { flips, pinnedPasses, crumbs } = runFieldChurn(stepMs)

      expect(pinnedPasses).toBeGreaterThan(flips * floor)
      expect(crumbs).toBeLessThan(20)
    })

    // Why this asserts the gap rather than closing it: reaching the notice
    // limit takes NOTICE_LIMIT - 1 intervals, so churn averaging slower than
    // 60s/11 = 5454.5ms per flip never reaches it and stays undamped — before
    // this change and after, which is why the crumb count is 0 rather than 43.
    // The edge is sharp: this harness pins 60% of passes at 5450ms and 0% at
    // 5460ms. Closing the gap means widening the window, which would also
    // re-arm the pin on honest parking — that round-trips on the order of
    // minutes.
    //
    // The field is NOT comfortably clear of this: its slowest observed episode
    // runs 5441.8ms per flip, 12.7ms inside the edge. Churn a hair slower than
    // anything yet observed would evade the damper entirely. Recorded so a
    // later change to either constant cannot move the edge unnoticed.
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
        .map((call) => (call[1] as { pinnedForMs: number }).pinnedForMs)
      expect(pinnedForMs[0]).toBe(TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
      expect(pinnedForMs.at(-1)).toBe(TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS)
    })

    // Why this drives the loop the way useTerminalParkVerdictPin does — record
    // first, then subtract the pinned set from the NEXT pass's verdict — and
    // why every other test here must not: with the pin fed back, a pinned tab
    // records no flip at all, and that is the state the back-off has to survive.
    // The open-loop harness above cannot see it, and shipped a fix whose
    // exponential back-off never left 1x in production: the quiet-branch reset
    // measured staleness from windowStartMs, which a pin always makes older
    // than a full window, so every lapse wiped the count.
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
        pinnedForMs: crumbs.map((call) => (call[1] as { pinnedForMs: number }).pinnedForMs)
      }
    }

    it('reaches the ceiling under the real pin feedback loop', () => {
      const { pinnedForMs } = runClosedLoopChurn(FIELD_FLIP_INTERVAL_MS)

      // The whole sequence, not just its ends: a base-8 back-off, or a reset
      // that fires one window early, both pass an ends-only assertion.
      expect(pinnedForMs.length).toBeGreaterThan(3)
      expect(pinnedForMs.slice(0, 4)).toEqual([
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2,
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 4,
        TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 8
      ])
      expect(pinnedForMs.at(-1)).toBe(TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS)
    })

    // The user-visible quantity. Every flip that survives the pin is one pane
    // remount; the percentages elsewhere are a pin duty cycle, not this.
    it('cuts remounts against the undamped baseline', () => {
      const { remounts, crumbs } = runClosedLoopChurn(FIELD_FLIP_INTERVAL_MS)

      // Undamped, 20 min at 4627ms/flip is 260 remounts and 20 crumbs.
      expect(remounts).toBeLessThan(80)
      expect(crumbs).toBeLessThan(10)
    })

    // Why this drives the pin into the SAME pass that records the flip: engaging
    // the pin is itself a rendered verdict transition — the hook drops the tab
    // from the parked set and the effect re-runs on the changed dep — so a flip
    // lands while the pin is live. That flip used to overwrite the pin deadline
    // with the current time, and the back-off then cleared one window later
    // rather than one window after the pin ended.
    //
    // It also kills `easedFlipCount -> noticeLimit`, which is behaviourally the
    // revision this one replaced and which the open-loop tests cannot see.
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
        .map((call) => (call[1] as { pinnedForMs: number }).pinnedForMs)
      expect(Math.max(...pinnedForMs)).toBe(TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS)
    })

    // Why: the back-off must not accumulate across episodes that are not
    // consecutive. Four isolated 12-flip episodes six hours apart previously
    // reached the 8-minute ceiling, because the flip path's reset was gated on
    // `flips < noticeLimit` and the notice path leaves `flips` at exactly
    // noticeLimit — so a window reopening after hours of silence did not reset.
    // Each episode resumes ON a flip, so nothing lands in the quiet branch.
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
        .map((call) => (call[1] as { pinnedForMs: number }).pinnedForMs)
      expect(pinnedForMs).toHaveLength(4)
      expect(pinnedForMs.every((ms) => ms === TERMINAL_TAB_PARK_FLIP_WINDOW_MS)).toBe(true)
    })

    // Why this range and not one cadence: past roughly 4.7s per flip a lapsing
    // pin pushes the next window out of alignment so it closes at 11 of 12.
    // Gating the reset on `flips < noticeLimit` read that as the churn easing
    // and reset the back-off every cycle, leaving it stuck at 1x across the
    // slower half of the field's own observed range — the half where damping is
    // weakest to begin with. The back-off must still climb there.
    it.each([4_800, 5_000, FIELD_SLOWEST_FLIP_INTERVAL_MS])(
      'still backs off above the alignment cliff at %ims per flip',
      (stepMs) => {
        runFieldChurn(stepMs)

        const pinnedForMs = recordBreadcrumb.mock.calls
          .filter((call) => call[0] === 'terminal_park_verdict_churn')
          .map((call) => (call[1] as { pinnedForMs: number }).pinnedForMs)
        expect(Math.max(...pinnedForMs)).toBeGreaterThan(TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
      }
    )

    // Why: without this the back-off is a ratchet — a tab that churned once at
    // launch would still be carrying an 8-minute pin hours later.
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

  // Why this is NOT the test that covers the below-limit reset: its gap is also
  // a full quiet window, so the quiet disjunct alone satisfies it and deleting
  // the below-limit clause stays invisible here. The sparse-churn test below is
  // the one that distinguishes them; this one only pins that a reset exists.
  it('clears the back-off when a window closes below the notice limit', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
    }
    expect(records.get(TAB)?.sustainedPinCount).toBe(1)

    // One flip, a full window later: the window closes holding far fewer than
    // the notice limit, which is the only proof the churn actually stopped.
    const nextWindowMs = 1_000 + TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS * 2
    observe({ records, parked: false, nowMs: nextWindowMs })
    observe({ records, parked: true, nowMs: nextWindowMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS + 1 })

    expect(records.get(TAB)?.sustainedPinCount).toBe(0)
  })

  // Why this shape and not a quiet gap: it is the only one that separates the
  // two reset conditions. One flip every 20s is three per window — below the
  // eased threshold, so the below-limit clause fires — while the last flip is
  // never a full window old, so the quiet clause never does. Without the
  // below-limit clause the back-off stays armed indefinitely under churn that
  // has demonstrably eased, and the next notice pins for the ceiling rather
  // than one window. Four mutations of that clause survived every other test.
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

  // Why: an unclamped backwards jump would freeze the window and suppress the
  // very signal this module exists to capture.
  it('treats a backwards clock jump as a fresh window', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 10_000_000 })
    observe({ records, parked: false, nowMs: 1_000 })

    expect(records.get(TAB)?.windowStartMs).toBe(1_000)
    expect(records.get(TAB)?.flips).toBe(1)
  })

  // Why: >= is the boundary operator; a > regression would silently stretch the
  // window and delay every notice by one full period.
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

    // Why 'window': the 100ms step outruns the 10ms burst window, so the burst
    // counter resets on every flip and only the notice limit can fire.
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

  // Why the deadline and not a boolean: the caller has to schedule a recheck at
  // it, or the pin never lifts once it has stopped the churn that woke the
  // verdict effect.
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

  // Why: the notice window starts at the first flip and the pin starts one
  // burst later, so the notice window always lapses first. Resetting it must
  // not hand the pane back to the parking policy mid-damping.
  it('survives a notice-window expiry that lands mid-pin', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const pinnedAtMs = churnToBurst(records)
    const pinUntilMs = pinnedAtMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS
    const windowLapseMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS

    // An exogenous flip (visibility change, tab removal) after the notice
    // window lapsed but before the pin deadline.
    expect(windowLapseMs).toBeLessThan(pinUntilMs)
    observe({ records, parked: true, nowMs: windowLapseMs })

    expect(records.get(TAB)?.flips).toBe(1)
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: windowLapseMs })).toBe(
      pinUntilMs
    )
  })
})

// Why liveness and not presence: a pinned tab can stop being cold-park eligible
// before its deadline, and nothing consults getParkVerdictUnparkPinUntilMs for
// it again. A stale deadline must not silence churn telemetry forever.
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

    // Slow churn only: each step outruns the burst window, so the notice limit
    // is the only trigger left. It must not stay gated by the lapsed pin.
    const afterPinMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i <= TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: afterPinMs + i * SLOW_CHURN_STEP_MS })
    }

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window' })
    )
  })

  // Why: the pin is set from flips on the rendered verdict, so it has to be
  // readable — and expirable — for any live tab, not only cold-park candidates
  // (issue #15136: the driver was the worktree-level park prop).
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
