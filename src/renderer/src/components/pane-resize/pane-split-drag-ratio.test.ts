import { describe, expect, it } from 'vitest'
import { getDraggedSplitRatio } from './pane-split-drag-ratio'

const still = {
  startContainerPos: 100,
  containerPos: 100,
  startAvailablePx: 1000,
  availablePx: 1000
}

describe('getDraggedSplitRatio', () => {
  it('keeps an unequal split still when the pointer has not moved, wherever it grabbed', () => {
    expect(getDraggedSplitRatio({ ...still, startRatio: 0.2, startPos: 310, pos: 310 })).toBe(0.2)
  })

  it('moves the split by exactly the pointer displacement', () => {
    expect(getDraggedSplitRatio({ ...still, startRatio: 0.5, startPos: 600, pos: 700 })).toBe(0.6)
  })

  it('keeps the seam under the pointer when the container resizes or moves mid-drag', () => {
    // Seam started at 100 + 0.5 * 1000 = 600 with the pointer 4px past it; the container then
    // moves to x=60 and grows to 1200px while the pointer stays at 604.
    const ratio = getDraggedSplitRatio({
      startRatio: 0.5,
      startPos: 604,
      pos: 604,
      startContainerPos: 100,
      containerPos: 60,
      startAvailablePx: 1000,
      availablePx: 1200
    })
    expect(ratio).toBe(0.45)
  })

  it('stops at the 15%/85% limits', () => {
    expect(getDraggedSplitRatio({ ...still, startRatio: 0.5, startPos: 600, pos: 0 })).toBe(0.15)
    expect(getDraggedSplitRatio({ ...still, startRatio: 0.5, startPos: 600, pos: 2000 })).toBe(0.85)
  })

  it('never moves a restored out-of-range ratio further out, but lets it move inward', () => {
    expect(getDraggedSplitRatio({ ...still, startRatio: 0.9, startPos: 1000, pos: 1050 })).toBe(0.9)
    expect(getDraggedSplitRatio({ ...still, startRatio: 0.9, startPos: 1000, pos: 900 })).toBe(0.8)
  })

  it('ignores moves when the split has no room', () => {
    expect(
      getDraggedSplitRatio({ ...still, availablePx: 0, startRatio: 0.5, startPos: 0, pos: 10 })
    ).toBeNull()
  })
})
