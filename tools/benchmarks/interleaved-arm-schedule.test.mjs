import { describe, expect, it } from 'vitest'

import {
  buildAbbaSchedule,
  isCounterbalanced,
  meanLaunchPositions
} from './interleaved-arm-schedule.mjs'

describe('buildAbbaSchedule', () => {
  it('flips the within-pair order on alternating pairs', () => {
    expect(buildAbbaSchedule(4)).toEqual([
      ['baseline', 'candidate'],
      ['candidate', 'baseline'],
      ['baseline', 'candidate'],
      ['candidate', 'baseline']
    ])
  })

  it('lays out as ABBA blocks once flattened', () => {
    expect(buildAbbaSchedule(2).flat()).toEqual(['baseline', 'candidate', 'candidate', 'baseline'])
  })

  it('gives both arms the same number of launches', () => {
    const flat = buildAbbaSchedule(7).flat()
    expect(flat.filter((arm) => arm === 'baseline')).toHaveLength(7)
    expect(flat.filter((arm) => arm === 'candidate')).toHaveLength(7)
  })
})

describe('meanLaunchPositions', () => {
  it('places both arms at the same mean slot for an even pair count', () => {
    for (const pairCount of [2, 4, 8, 20]) {
      const positions = meanLaunchPositions(buildAbbaSchedule(pairCount))
      expect(positions.candidate).toBeCloseTo(positions.baseline, 10)
    }
  })

  it('leaves a residual offset when the pair count is odd', () => {
    const positions = meanLaunchPositions(buildAbbaSchedule(3))
    expect(positions.baseline).not.toBeCloseTo(positions.candidate, 10)
  })

  it('cancels a linear drift out of the paired deltas', () => {
    // Same true cost per arm; the machine adds 10ms per launch slot.
    const trueCost = { baseline: 1000, candidate: 900 }
    const driftPerSlot = 10
    const schedule = buildAbbaSchedule(8)
    const flat = schedule.flat()
    const observed = flat.map((arm, slot) => trueCost[arm] + driftPerSlot * slot)

    const deltas = schedule.map((pair, index) => {
      const firstSlot = index * 2
      const byArm = {
        [pair[0]]: observed[firstSlot],
        [pair[1]]: observed[firstSlot + 1]
      }
      return byArm.candidate - byArm.baseline
    })
    const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length

    expect(meanDelta).toBeCloseTo(trueCost.candidate - trueCost.baseline, 10)
  })

  it('lets drift leak into the deltas when the arms are not interleaved', () => {
    // Blocked design: all baseline launches, then all candidate launches.
    const trueCost = { baseline: 1000, candidate: 900 }
    const driftPerSlot = 10
    const blocked = [...Array(8).fill('baseline'), ...Array(8).fill('candidate')]
    const observed = blocked.map((arm, slot) => trueCost[arm] + driftPerSlot * slot)
    const baselineMean = observed.slice(0, 8).reduce((sum, v) => sum + v, 0) / 8
    const candidateMean = observed.slice(8).reduce((sum, v) => sum + v, 0) / 8

    // The real gain is -100ms. The blocked design reports -20ms: the 8 slots of
    // drift between the two blocks (+80ms) are charged entirely to the candidate,
    // erasing four fifths of a real improvement.
    expect(candidateMean - baselineMean).toBeCloseTo(-20, 10)
  })
})

describe('isCounterbalanced', () => {
  it('accepts even pair counts and rejects odd or empty ones', () => {
    expect(isCounterbalanced(8)).toBe(true)
    expect(isCounterbalanced(7)).toBe(false)
    expect(isCounterbalanced(0)).toBe(false)
  })
})
