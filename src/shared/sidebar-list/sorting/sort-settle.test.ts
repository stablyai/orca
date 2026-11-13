import { describe, expect, it } from 'vitest'
import { reduceSortSettle, type SortSettleEvent } from './sort-settle'

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
