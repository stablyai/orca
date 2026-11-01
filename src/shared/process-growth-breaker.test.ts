import { describe, expect, it } from 'vitest'
import {
  countDescendantsByRoot,
  createProcessGrowthState,
  DEFAULT_PROCESS_GROWTH_LIMITS as LIMITS,
  evaluateProcessGrowth
} from './process-growth-breaker'

function sample(atMs: number, host: number | null, scopes: Record<string, number> = {}) {
  return { atMs, hostDescendants: host, scopes: new Map(Object.entries(scopes)) }
}

describe('evaluateProcessGrowth', () => {
  it('trips only after three rising samples over 10 s, and names the agent that grew', () => {
    const state = createProcessGrowthState()
    const levels: string[] = []
    let verdict = evaluateProcessGrowth(state, sample(0, 10, { a: 5, b: 5 }), LIMITS)
    for (let step = 1; step <= 3; step++) {
      const t = step * 5_000
      verdict = evaluateProcessGrowth(
        state,
        sample(t, 10 + step * 250, { a: 5 + step * 250, b: 5 }),
        LIMITS
      )
      levels.push(verdict.level)
    }
    expect(levels).toEqual(['elevated', 'elevated', 'critical'])
    expect(verdict.trips).toEqual(
      expect.arrayContaining([{ scopeId: 'a', descendants: 755, growthPerSecond: 50 }])
    )
    expect(verdict.trips.some((trip) => trip.scopeId === 'b')).toBe(false)
  })

  it('never trips on one long interval, however large the jump', () => {
    const state = createProcessGrowthState()
    evaluateProcessGrowth(state, sample(0, 0), LIMITS)
    expect(evaluateProcessGrowth(state, sample(30_000, 1_200), LIMITS).level).toBe('elevated')
  })

  it('resets the streak once growth stops', () => {
    const state = createProcessGrowthState()
    evaluateProcessGrowth(state, sample(0, 0), LIMITS)
    evaluateProcessGrowth(state, sample(5_000, 300), LIMITS)
    evaluateProcessGrowth(state, sample(10_000, 600), LIMITS)
    expect(evaluateProcessGrowth(state, sample(15_000, 600), LIMITS).level).toBe('ok')
    expect(evaluateProcessGrowth(state, sample(20_000, 900), LIMITS).level).toBe('elevated')
  })

  it('reports a high total as elevated load, never as a trip', () => {
    const state = createProcessGrowthState()
    expect(evaluateProcessGrowth(state, sample(0, LIMITS.hostElevatedDescendants), LIMITS)).toEqual(
      {
        level: 'elevated',
        trips: [],
        rising: false
      }
    )
  })

  it('treats an unreadable table as unknown, never as a trip or a reset', () => {
    const state = createProcessGrowthState()
    evaluateProcessGrowth(state, sample(0, 0), LIMITS)
    evaluateProcessGrowth(state, sample(5_000, 300), LIMITS)
    evaluateProcessGrowth(state, sample(10_000, 600), LIMITS)
    expect(evaluateProcessGrowth(state, sample(12_000, null), LIMITS)).toEqual({
      level: 'unknown',
      trips: [],
      rising: true
    })
    expect(evaluateProcessGrowth(state, sample(15_000, 900), LIMITS).level).toBe('critical')
  })
})

describe('countDescendantsByRoot', () => {
  it('counts each root tree and tolerates cycles', () => {
    const rows = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 2 },
      { pid: 5, ppid: 1 },
      { pid: 6, ppid: 7 },
      { pid: 7, ppid: 6 }
    ]
    expect(countDescendantsByRoot(rows, [1, 2, 5, 6, 99])).toEqual(
      new Map([
        [1, 4],
        [2, 2],
        [5, 0],
        [6, 1],
        [99, 0]
      ])
    )
  })
})
