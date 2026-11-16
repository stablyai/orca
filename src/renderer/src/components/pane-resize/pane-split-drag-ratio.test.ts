import { describe, expect, it } from 'vitest'
import { getDraggedSplitRatio } from './pane-split-drag-ratio'

describe('getDraggedSplitRatio', () => {
  it('keeps an unequal split still when the pointer has not moved, wherever it grabbed', () => {
    expect(
      getDraggedSplitRatio({ startRatio: 0.2, startPos: 610, pos: 610, availablePx: 994 })
    ).toBe(0.2)
  })

  it('moves the split by exactly the pointer displacement', () => {
    expect(
      getDraggedSplitRatio({ startRatio: 0.5, startPos: 500, pos: 600, availablePx: 1000 })
    ).toBe(0.6)
  })

  it('stops at the 15%/85% limits', () => {
    expect(
      getDraggedSplitRatio({ startRatio: 0.5, startPos: 500, pos: 0, availablePx: 1000 })
    ).toBe(0.15)
    expect(
      getDraggedSplitRatio({ startRatio: 0.5, startPos: 500, pos: 1000, availablePx: 1000 })
    ).toBe(0.85)
  })

  it('never moves a restored out-of-range ratio further out, but lets it move inward', () => {
    expect(
      getDraggedSplitRatio({ startRatio: 0.9, startPos: 900, pos: 950, availablePx: 1000 })
    ).toBe(0.9)
    expect(
      getDraggedSplitRatio({ startRatio: 0.9, startPos: 900, pos: 800, availablePx: 1000 })
    ).toBe(0.8)
  })

  it('ignores moves when the split has no room', () => {
    expect(
      getDraggedSplitRatio({ startRatio: 0.5, startPos: 0, pos: 10, availablePx: 0 })
    ).toBeNull()
  })
})
