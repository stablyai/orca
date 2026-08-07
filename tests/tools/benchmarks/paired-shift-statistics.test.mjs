import { describe, expect, it } from 'vitest'

import {
  bootstrapShiftInterval,
  detectDrift,
  hodgesLehmannShift,
  median,
  pairedDeltas,
  summarisePairedShift
} from './paired-shift-statistics.mjs'

describe('median', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('ignores nulls from phases a launch never reached', () => {
    expect(median([null, 10, undefined, 20, Number.NaN, 30])).toBe(20)
  })

  it('returns null when nothing is measurable', () => {
    expect(median([null, undefined])).toBeNull()
  })
})

describe('hodgesLehmannShift', () => {
  it('takes the median over Walsh averages including self-pairs', () => {
    // [1,2,3] -> averages [1, 1.5, 2, 2, 2.5, 3] -> median 2
    expect(hodgesLehmannShift([1, 2, 3])).toBe(2)
  })

  it('resists a single catastrophic launch that flips the mean', () => {
    const samples = [-10, -11, -9, -10, -10, 500]
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    expect(mean).toBeGreaterThan(0)
    expect(hodgesLehmannShift(samples)).toBeLessThan(0)
  })
})

describe('bootstrapShiftInterval', () => {
  it('brackets the point estimate', () => {
    const samples = [-105, -98, -102, -99, -101, -100, -103, -97]
    const [low, high] = bootstrapShiftInterval(samples)
    const shift = hodgesLehmannShift(samples)
    expect(low).toBeLessThanOrEqual(shift)
    expect(high).toBeGreaterThanOrEqual(shift)
  })

  it('is reproducible from the same samples', () => {
    const samples = [-40, 12, -33, 7, -21, 3, -50, 18]
    expect(bootstrapShiftInterval(samples)).toEqual(bootstrapShiftInterval(samples))
  })

  it('declines to guess below two pairs', () => {
    expect(bootstrapShiftInterval([-100])).toBeNull()
  })
})

describe('summarisePairedShift', () => {
  it('calls a consistent speedup improved', () => {
    const summary = summarisePairedShift([-105, -98, -102, -99, -101, -100, -103, -97])
    expect(summary.verdict).toBe('improved')
    expect(summary.interval[1]).toBeLessThan(0)
    expect(summary.pairs).toBe(8)
  })

  it('calls a consistent slowdown regressed', () => {
    expect(summarisePairedShift([88, 95, 91, 90, 93, 89, 94, 92]).verdict).toBe('regressed')
  })

  it('refuses a verdict when the deltas straddle zero', () => {
    const summary = summarisePairedShift([-100, 120, -30, 80, -60, 45, 10, -75])
    expect(summary.verdict).toBe('inconclusive')
    expect(summary.interval[0]).toBeLessThan(0)
    expect(summary.interval[1]).toBeGreaterThan(0)
  })

  it('reports no-data rather than a shift when every pair is incomplete', () => {
    expect(summarisePairedShift([null, null])).toEqual({
      pairs: 0,
      shift: null,
      interval: null,
      verdict: 'no-data'
    })
  })
})

describe('pairedDeltas', () => {
  const pairs = [
    { baseline: { phases: { total: 1000 } }, candidate: { phases: { total: 900 } } },
    { baseline: { phases: { total: 1100 } }, candidate: { phases: { total: 940 } } },
    { baseline: { phases: { total: null } }, candidate: { phases: { total: 950 } } },
    { baseline: { phases: {} }, candidate: { phases: {} } }
  ]

  it('subtracts baseline from candidate per pair', () => {
    expect(pairedDeltas(pairs, 'total')).toEqual([-100, -160, null, null])
  })

  it('drops a pair whose arms did not both reach the phase', () => {
    expect(summarisePairedShift(pairedDeltas(pairs, 'total')).pairs).toBe(2)
  })
})

describe('detectDrift', () => {
  const summaries = {
    spawnToAppReady: { verdict: 'inconclusive', shift: -4 },
    appReadyToServices: { verdict: 'inconclusive', shift: 2 },
    totalToDidFinishLoad: { verdict: 'improved', shift: -1150 }
  }

  it('stays quiet when the control phases show no direction', () => {
    const drift = detectDrift(summaries, ['spawnToAppReady', 'appReadyToServices'])
    expect(drift.detected).toBe(false)
    expect(drift.measured).toBe(true)
    expect(drift.controls).toHaveLength(2)
  })

  it('flags the run when a phase the change cannot touch moved', () => {
    const drift = detectDrift(
      { ...summaries, spawnToAppReady: { verdict: 'improved', shift: -300 } },
      ['spawnToAppReady', 'appReadyToServices']
    )
    expect(drift.detected).toBe(true)
    expect(drift.drifting.map((control) => control.phase)).toEqual(['spawnToAppReady'])
  })

  // Why: 'no-data' is the absence of a measurement, not a direction. Counting it
  // as drift would mark every real verdict unproven whenever a platform-specific
  // control phase (aclGrantMs off win32) simply never fired.
  it('does not treat a control neither arm reached as drift', () => {
    const drift = detectDrift({ ...summaries, aclGrantMs: { verdict: 'no-data', shift: null } }, [
      'spawnToAppReady',
      'aclGrantMs'
    ])
    expect(drift.detected).toBe(false)
    expect(drift.unmeasured).toEqual(['aclGrantMs'])
    expect(drift.measured).toBe(true)
  })

  it('reports control phases the run never produced as unmeasured, not as quiet', () => {
    const drift = detectDrift(summaries, ['aclGrantMs'])
    expect(drift.controls).toEqual([])
    expect(drift.unmeasured).toEqual(['aclGrantMs'])
    // The distinction that matters: no drift was found because none was looked for.
    expect(drift.detected).toBe(false)
    expect(drift.measured).toBe(false)
  })
})
