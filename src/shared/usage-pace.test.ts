import { describe, expect, it } from 'vitest'
import type { RateLimitWindow } from './rate-limit-types'
import { getResetCountdownNextTickDelay } from './rate-limit-reset-format'
import { getUsagePace, getUsagePaceNextChangeAt } from './usage-pace'

const NOW = 1_700_000_000_000
const WEEK_MINUTES = 10_080
const SESSION_MINUTES = 300

function weekly(usedPercent: number, elapsedFraction: number): RateLimitWindow {
  const durationMs = WEEK_MINUTES * 60_000
  return {
    usedPercent,
    windowMinutes: WEEK_MINUTES,
    resetsAt: NOW + durationMs * (1 - elapsedFraction),
    resetDescription: null
  }
}

describe('getUsagePace', () => {
  it('reports reserve when usage trails the even burn', () => {
    // 2 of 7 days elapsed (~28.6% expected) against 10% used.
    const pace = getUsagePace(weekly(10, 2 / 7), NOW)
    expect(pace?.stage).toBe('reserve')
    expect(pace?.displayDeltaPercent).toBe(19)
    expect(pace?.expectedUsedPercent).toBeCloseTo(28.57, 2)
  })

  it('reports deficit when usage outruns the even burn', () => {
    const pace = getUsagePace(weekly(50, 2 / 7), NOW)
    expect(pace?.stage).toBe('deficit')
    expect(pace?.displayDeltaPercent).toBe(21)
  })

  it('holds on-pace across the tolerance band and drops it one point past', () => {
    const expected = (2 / 7) * 100
    expect(getUsagePace(weekly(expected + 2, 2 / 7), NOW)?.stage).toBe('on-pace')
    expect(getUsagePace(weekly(expected - 2, 2 / 7), NOW)?.stage).toBe('on-pace')
    expect(getUsagePace(weekly(expected + 3, 2 / 7), NOW)?.stage).toBe('deficit')
    expect(getUsagePace(weekly(expected - 3, 2 / 7), NOW)?.stage).toBe('reserve')
  })

  it('never prints a delta inside the on-pace band', () => {
    for (let used = 0; used <= 100; used += 1) {
      const pace = getUsagePace(weekly(used, 2 / 7), NOW)
      if (pace && pace.stage !== 'on-pace') {
        expect(pace.displayDeltaPercent).toBeGreaterThan(2)
      }
    }
  })

  it('reconciles its delta against the rounded percentage the panel prints', () => {
    const pace = getUsagePace(weekly(12.6, 0.5), NOW)
    expect(pace?.usedPercent).toBe(13)
    expect(pace?.displayDeltaPercent).toBe(37)
  })

  it('stays silent until enough of the window has elapsed', () => {
    expect(getUsagePace(weekly(0, 0.02), NOW)).toBeNull()
    expect(getUsagePace(weekly(0, 0.031), NOW)).not.toBeNull()
  })

  it('stays silent when the window carries no reset timestamp', () => {
    expect(
      getUsagePace(
        { usedPercent: 10, windowMinutes: WEEK_MINUTES, resetsAt: null, resetDescription: null },
        NOW
      )
    ).toBeNull()
  })

  it('stays silent once the reset has passed', () => {
    expect(getUsagePace({ ...weekly(10, 1), resetsAt: NOW - 1 }, NOW)).toBeNull()
  })

  it('stays silent when the reset sits beyond the window length', () => {
    const durationMs = WEEK_MINUTES * 60_000
    expect(getUsagePace({ ...weekly(10, 0.5), resetsAt: NOW + durationMs + 1 }, NOW)).toBeNull()
  })

  it('stays silent for a non-positive window length', () => {
    expect(getUsagePace({ ...weekly(10, 0.5), windowMinutes: 0 }, NOW)).toBeNull()
  })

  it('treats unusable usage numbers as zero rather than dropping the pace', () => {
    const pace = getUsagePace({ ...weekly(0, 0.5), usedPercent: Number.NaN }, NOW)
    expect(pace?.usedPercent).toBe(0)
    expect(pace?.stage).toBe('reserve')
  })

  it('lasts to reset when the burn rate leaves capacity at the reset', () => {
    const pace = getUsagePace(weekly(10, 0.5), NOW)
    expect(pace?.willLastToReset).toBe(true)
    expect(pace?.runsOutInMs).toBeNull()
  })

  it('projects a run-out when the burn rate exhausts the window early', () => {
    // Half the window gone, 75% spent → the remaining 25% lasts another sixth of a week.
    const pace = getUsagePace(weekly(75, 0.5), NOW)
    expect(pace?.willLastToReset).toBe(false)
    expect(pace?.runsOutInMs).toBeCloseTo((WEEK_MINUTES * 60_000) / 6, 0)
  })

  it('reports an exhausted window as already out', () => {
    const pace = getUsagePace(weekly(100, 0.5), NOW)
    expect(pace?.willLastToReset).toBe(false)
    expect(pace?.runsOutInMs).toBe(0)
  })

  it('lasts to reset on an untouched window', () => {
    const pace = getUsagePace(weekly(0, 0.5), NOW)
    expect(pace?.willLastToReset).toBe(true)
    expect(pace?.runsOutInMs).toBeNull()
  })

  it('applies the same budget to short session windows', () => {
    const durationMs = SESSION_MINUTES * 60_000
    const pace = getUsagePace(
      {
        usedPercent: 6,
        windowMinutes: SESSION_MINUTES,
        // 44 minutes into a 5h session → ~14.7% expected.
        resetsAt: NOW + durationMs - 44 * 60_000,
        resetDescription: null
      },
      NOW
    )
    expect(pace?.stage).toBe('reserve')
    expect(pace?.displayDeltaPercent).toBe(9)
  })
})

describe('getUsagePaceNextChangeAt', () => {
  const WEEK_MS = WEEK_MINUTES * 60_000

  // Re-reading the window at the returned instant must print something new.
  function readingAt(window: RateLimitWindow, at: number): string {
    const pace = getUsagePace(window, at)
    return pace
      ? `${pace.stage}|${pace.displayDeltaPercent}|${pace.willLastToReset}|${Math.floor((pace.runsOutInMs ?? -1) / 60_000)}`
      : 'none'
  }

  it('lands on the instant the printed delta turns over', () => {
    const window = weekly(10, 2 / 7)
    const at = getUsagePaceNextChangeAt(window, NOW)
    expect(at).not.toBeNull()
    // Just before the boundary the reading still matches; at it, it has moved.
    expect(readingAt(window, (at as number) - 1000)).toBe(readingAt(window, NOW))
    expect(readingAt(window, at as number)).not.toBe(readingAt(window, NOW))
  })

  it('names an instant the countdown grid would have missed', () => {
    // The countdown wakes hourly once a reset is over a day out. Its grid is set
    // by the reset time, so it lands after the pace reading has already turned
    // over — which is the staleness this exists to close.
    const window = weekly(10, 2 / 7)
    const changeAt = getUsagePaceNextChangeAt(window, NOW) as number
    let countdownTick = NOW
    while (countdownTick < changeAt) {
      countdownTick += getResetCountdownNextTickDelay(countdownTick, [
        window.resetsAt as number
      ]) as number
    }
    expect(countdownTick).toBeGreaterThan(changeAt)
  })

  it('waits for the window to become old enough to read', () => {
    const at = getUsagePaceNextChangeAt(weekly(0, 0.02), NOW)
    // 2% elapsed against a 3% floor leaves 1% of the week to wait.
    expect((at as number) - NOW).toBeCloseTo(WEEK_MS * 0.01, -3)
    expect(getUsagePace(weekly(0, 0.02), at as number)).not.toBeNull()
  })

  it('is silent for windows that carry no readable timing', () => {
    expect(
      getUsagePaceNextChangeAt(
        { usedPercent: 10, windowMinutes: WEEK_MINUTES, resetsAt: null, resetDescription: null },
        NOW
      )
    ).toBeNull()
    expect(getUsagePaceNextChangeAt({ ...weekly(10, 0.5), resetsAt: NOW - 1 }, NOW)).toBeNull()
  })

  it('always moves forward, so a clock driven by it cannot spin', () => {
    for (const used of [1, 10, 29, 50, 75, 99]) {
      for (const elapsed of [0.1, 0.3, 0.5, 0.9]) {
        const at = getUsagePaceNextChangeAt(weekly(used, elapsed), NOW)
        if (at !== null) {
          expect(at).toBeGreaterThan(NOW)
        }
      }
    }
  })

  it('catches the run-out projection turning over before the delta does', () => {
    // Heavy spend: the projection moves fast, so it is the earlier boundary.
    const window = weekly(75, 0.5)
    const at = getUsagePaceNextChangeAt(window, NOW)
    expect(readingAt(window, at as number)).not.toBe(readingAt(window, NOW))
  })
})
