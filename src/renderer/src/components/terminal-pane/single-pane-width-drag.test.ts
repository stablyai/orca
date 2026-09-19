import { describe, expect, it } from 'vitest'
import { resolveDraggedSinglePaneWidth } from './TerminalSinglePaneWidthHandles'

const drag = (
  deltaX: number,
  direction: 1 | -1,
  startWidth = 1000,
  containerWidth = 1600
): number => resolveDraggedSinglePaneWidth({ startWidth, deltaX, direction, containerWidth })

describe('dragging a centered pane edge', () => {
  it('grows by twice the pointer travel, since both edges move', () => {
    expect(drag(100, 1)).toBe(1200)
    expect(drag(-100, -1)).toBe(1200)
  })

  it('shrinks when the edge is dragged inward from either side', () => {
    expect(drag(-100, 1)).toBe(800)
    expect(drag(100, -1)).toBe(800)
  })

  it('stops at the tab edge so the pane never overflows', () => {
    expect(drag(9999, 1)).toBe(1600)
  })

  it('keeps the terminal usable at the low end', () => {
    expect(drag(-9999, 1)).toBe(400)
  })

  it('never returns a negative width when the tab has not been measured', () => {
    expect(drag(-9999, 1, 1000, 0)).toBe(0)
  })
})
