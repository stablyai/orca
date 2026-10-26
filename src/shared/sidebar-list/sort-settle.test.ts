import { describe, expect, it } from 'vitest'
import {
  reduceSortSettle,
  SORT_SETTLE_MS,
  type SortSettleEvent,
  type SortSettleState
} from './sort-settle'

const settled = { liveCountAtLastBump: 2, deadline: null }

function write(overrides: Partial<Extract<SortSettleEvent, { kind: 'write' }>>): SortSettleEvent {
  return {
    kind: 'write',
    change: { epochBumped: true, liveCount: 2 },
    settled: false,
    sortBy: 'recent',
    previousSortBy: 'recent',
    ...overrides
  }
}

describe('reduceSortSettle', () => {
  it('restarts the window on every bump in a burst and settles once at its deadline', () => {
    let state: SortSettleState = settled
    for (const now of [0, 1_000, 2_500]) {
      const step = reduceSortSettle(state, write({}), now)
      expect(step).toEqual({ state: { ...settled, deadline: now + SORT_SETTLE_MS }, settle: false })
      state = step.state
    }
    const quiet = reduceSortSettle(state, write({ change: null }), 4_000)
    expect(quiet.state.deadline).toBe(2_500 + SORT_SETTLE_MS)
    expect(reduceSortSettle(quiet.state, { kind: 'deadline' }, 5_500)).toEqual({
      state: settled,
      settle: true
    })
  })

  it('settles adds and removes at once, against the count at the last bump', () => {
    const pending = reduceSortSettle(settled, write({}), 0).state
    expect(
      reduceSortSettle(pending, write({ change: { epochBumped: false, liveCount: 3 } }), 10)
    ).toEqual({
      state: settled,
      settle: true
    })
    expect(
      reduceSortSettle(pending, write({ change: { epochBumped: true, liveCount: 1 } }), 10)
    ).toEqual({
      state: { liveCountAtLastBump: 1, deadline: null },
      settle: true
    })
  })

  it('retires a pending deadline when a write lands settled', () => {
    const pending = reduceSortSettle(settled, write({}), 0).state
    const reset = reduceSortSettle(pending, write({ change: null, settled: true }), 10)
    expect(reset).toEqual({ state: settled, settle: false })
    expect(reduceSortSettle(reset.state, { kind: 'deadline' }, 3_000).settle).toBe(false)
  })
})
