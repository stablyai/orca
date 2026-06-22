import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_THREAD_COMPACT_ROW_ESTIMATE_PX,
  ACTIVITY_THREAD_GROUP_ROW_ESTIMATE_PX,
  ACTIVITY_THREAD_REGULAR_ROW_ESTIMATE_PX,
  ACTIVITY_THREAD_VIRTUALIZER_OVERSCAN,
  buildActivityThreadVirtualRows,
  estimateActivityThreadVirtualRowSize,
  getActiveActivityThreadStickyIndex,
  getActivityThreadStickyIndexes
} from './activity-thread-virtual-rows'

type TestThread = {
  paneKey: string
}

describe('activity thread virtual rows', () => {
  it('flattens grouped threads into stable header and row keys', () => {
    const rows = buildActivityThreadVirtualRows<TestThread>(
      [
        {
          key: 'working',
          label: 'Working',
          threads: [{ paneKey: 'pane-a' }, { paneKey: 'pane-b' }]
        },
        {
          key: 'done',
          label: 'Done',
          threads: [{ paneKey: 'pane-c' }]
        }
      ],
      (thread) => thread.paneKey
    )

    expect(rows.map((row) => row.key)).toEqual([
      'group:working',
      'thread:pane-a',
      'thread:pane-b',
      'group:done',
      'thread:pane-c'
    ])
    expect(getActivityThreadStickyIndexes(rows)).toEqual([0, 3])
  })

  it('selects the nearest previous group header as the active sticky row', () => {
    expect(getActiveActivityThreadStickyIndex([0, 3, 8], 0)).toBe(0)
    expect(getActiveActivityThreadStickyIndex([0, 3, 8], 6)).toBe(3)
    expect(getActiveActivityThreadStickyIndex([0, 3, 8], 12)).toBe(8)
    expect(getActiveActivityThreadStickyIndex([], 12)).toBeNull()
  })

  it('estimates compact rows smaller than regular rows', () => {
    const rows = buildActivityThreadVirtualRows<TestThread>(
      [{ key: 'working', label: 'Working', threads: [{ paneKey: 'pane-a' }] }],
      (thread) => thread.paneKey
    )

    expect(estimateActivityThreadVirtualRowSize(rows[0], false)).toBeLessThan(
      estimateActivityThreadVirtualRowSize(rows[1], false)
    )
    expect(estimateActivityThreadVirtualRowSize(rows[1], true)).toBeLessThan(
      estimateActivityThreadVirtualRowSize(rows[1], false)
    )
    expect(estimateActivityThreadVirtualRowSize(rows[0], false)).toBe(
      ACTIVITY_THREAD_GROUP_ROW_ESTIMATE_PX
    )
    expect(estimateActivityThreadVirtualRowSize(rows[1], true)).toBe(
      ACTIVITY_THREAD_COMPACT_ROW_ESTIMATE_PX
    )
    expect(estimateActivityThreadVirtualRowSize(rows[1], false)).toBe(
      ACTIVITY_THREAD_REGULAR_ROW_ESTIMATE_PX
    )
  })

  it('keeps enough overscan for fast scrolling before low-end devices measure rows', () => {
    expect(ACTIVITY_THREAD_VIRTUALIZER_OVERSCAN).toBeGreaterThanOrEqual(12)
  })
})
