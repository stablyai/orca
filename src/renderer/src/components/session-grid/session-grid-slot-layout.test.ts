import { describe, expect, it } from 'vitest'
import { computeSessionGridSlotCounts } from './session-grid-slot-layout'

describe('computeSessionGridSlotCounts', () => {
  it.each([
    // An exact multiple of cols used to yield zero empty slots — nowhere to launch.
    { itemCount: 4, cols: 2, rowsPerView: 2, emptySlotCount: 2, totalPageCount: 2 },
    // A partial row: finish it, then a whole trailing row.
    { itemCount: 3, cols: 2, rowsPerView: 2, emptySlotCount: 3, totalPageCount: 2 },
    // Never fewer than one full screen.
    { itemCount: 1, cols: 3, rowsPerView: 3, emptySlotCount: 8, totalPageCount: 1 },
    { itemCount: 0, cols: 2, rowsPerView: 2, emptySlotCount: 4, totalPageCount: 1 },
    { itemCount: 8, cols: 2, rowsPerView: 2, emptySlotCount: 2, totalPageCount: 3 }
  ])(
    '$itemCount items @ ${cols}x$rowsPerView leaves $emptySlotCount empty slots',
    ({ itemCount, cols, rowsPerView, emptySlotCount, totalPageCount }) => {
      const counts = computeSessionGridSlotCounts({ itemCount, cols, rowsPerView, showEmpty: true })
      expect(counts.totalSlotCount).toBe(itemCount + emptySlotCount)
      expect(counts.totalPageCount).toBe(totalPageCount)
    }
  )

  it('lays out only the items when empty slots are off', () => {
    const counts = computeSessionGridSlotCounts({
      itemCount: 5,
      cols: 2,
      rowsPerView: 2,
      showEmpty: false
    })
    expect(counts).toEqual({
      totalSlotCount: 5,
      totalRowCount: 3,
      totalPageCount: 2
    })
  })
})
