import { describe, expect, it } from 'vitest'
import { computeGridDimensions, computeSessionGridSlotCounts } from './session-grid-slot-layout'

describe('computeGridDimensions', () => {
  it.each([
    { preset: '1x2', cols: 1, rowsPerView: 2 },
    { preset: '2x1', cols: 2, rowsPerView: 1 },
    { preset: '2x2', cols: 2, rowsPerView: 2 },
    { preset: '3x1', cols: 3, rowsPerView: 1 },
    { preset: '3x2', cols: 3, rowsPerView: 2 },
    { preset: '3x3', cols: 3, rowsPerView: 3 }
  ] as const)('$preset reads as columns × rows per view', ({ preset, cols, rowsPerView }) => {
    expect(computeGridDimensions(preset, 0)).toEqual({ cols, rowsPerView })
  })
})

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
