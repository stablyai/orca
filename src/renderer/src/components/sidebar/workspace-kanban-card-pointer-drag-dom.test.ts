import { describe, expect, it } from 'vitest'
import {
  resolveWorkspaceKanbanCardDropCommitTarget,
  resolveWorkspaceCardDropIndexFromRects,
  resolveWorkspaceCardDropIndicatorY,
  resolveWorkspaceStatusDropTargetFromRects
} from './workspace-kanban-card-pointer-drag-dom'

const rects = [
  { status: 'todo', left: 0, top: 0, right: 200, bottom: 600 },
  { status: 'doing', left: 212, top: 0, right: 412, bottom: 600 },
  { status: 'done', left: 424, top: 0, right: 624, bottom: 600 }
]

describe('workspace kanban pointer drag drop target', () => {
  it('uses the containing lane when the pointer is inside one', () => {
    expect(resolveWorkspaceStatusDropTargetFromRects(rects, 240, 100)).toBe('doing')
  })

  it('falls back to the nearest lane when the pointer is in a lane gap', () => {
    expect(resolveWorkspaceStatusDropTargetFromRects(rects, 206, 100)).toBe('todo')
    expect(resolveWorkspaceStatusDropTargetFromRects(rects, 418, 100)).toBe('doing')
  })

  it('does not resolve a lane outside the lane row', () => {
    expect(resolveWorkspaceStatusDropTargetFromRects(rects, 206, 620)).toBeNull()
  })
})

describe('workspace kanban pointer drag card drop index', () => {
  const cardRects = [
    { top: 0, bottom: 40 },
    { top: 48, bottom: 88 },
    { top: 96, bottom: 136 }
  ]

  it('inserts before the first card whose midpoint is below the pointer', () => {
    expect(resolveWorkspaceCardDropIndexFromRects(cardRects, 10)).toBe(0)
    expect(resolveWorkspaceCardDropIndexFromRects(cardRects, 70)).toBe(2)
  })

  it('inserts at the end when the pointer is below every card midpoint', () => {
    expect(resolveWorkspaceCardDropIndexFromRects(cardRects, 140)).toBe(3)
  })

  // Why: a virtualized lane only renders its window, so rendered position is
  // not lane position. Without the carried index a drop into a scrolled lane
  // would land near the top of the list.
  it('uses the lane index of a rendered card rather than its rendered position', () => {
    const virtualized = [
      { top: 0, bottom: 40, index: 20 },
      { top: 48, bottom: 88, index: 21 },
      { top: 96, bottom: 136, index: 22 }
    ]
    expect(resolveWorkspaceCardDropIndexFromRects(virtualized, 10)).toBe(20)
    expect(resolveWorkspaceCardDropIndexFromRects(virtualized, 70)).toBe(22)
    expect(resolveWorkspaceCardDropIndexFromRects(virtualized, 140)).toBe(23)
  })
})

describe('workspace kanban drop indicator placement', () => {
  const cardRects = [
    { top: 100, bottom: 140 },
    { top: 148, bottom: 188 }
  ]

  it('places the line above, between, and below rendered cards', () => {
    expect(resolveWorkspaceCardDropIndicatorY(cardRects, 0, 90)).toBe(95)
    expect(resolveWorkspaceCardDropIndicatorY(cardRects, 1, 90)).toBe(144)
    expect(resolveWorkspaceCardDropIndicatorY(cardRects, 2, 90)).toBe(193)
  })

  it('falls back to the lane top when the lane renders no cards', () => {
    expect(resolveWorkspaceCardDropIndicatorY([], 0, 90)).toBe(104)
  })

  it('anchors to the rendered card that owns the lane index', () => {
    const virtualized = [
      { top: 100, bottom: 140, index: 20 },
      { top: 148, bottom: 188, index: 21 }
    ]
    expect(resolveWorkspaceCardDropIndicatorY(virtualized, 20, 90)).toBe(95)
    expect(resolveWorkspaceCardDropIndicatorY(virtualized, 21, 90)).toBe(144)
    expect(resolveWorkspaceCardDropIndicatorY(virtualized, 22, 90)).toBe(193)
  })
})

describe('workspace kanban pointer drag commit target', () => {
  it('uses the current target when release hit-testing succeeds', () => {
    expect(
      resolveWorkspaceKanbanCardDropCommitTarget({
        currentTarget: { status: 'doing', isPinDrop: false, dropIndex: 1 },
        latestTrackedTarget: {
          target: { status: 'done', isPinDrop: false, dropIndex: 0 },
          x: 100,
          y: 100
        },
        x: 100,
        y: 100
      })
    ).toEqual({ status: 'doing', isPinDrop: false, dropIndex: 1 })
  })

  it('reuses the latest tracked target when release hit-testing blanks at the same point', () => {
    expect(
      resolveWorkspaceKanbanCardDropCommitTarget({
        currentTarget: { status: null, isPinDrop: false, dropIndex: 0 },
        latestTrackedTarget: {
          target: { status: 'doing', isPinDrop: false, dropIndex: 2 },
          x: 100,
          y: 100
        },
        x: 102,
        y: 101
      })
    ).toEqual({ status: 'doing', isPinDrop: false, dropIndex: 2 })
  })

  it('does not reuse a tracked target after the pointer has moved away', () => {
    expect(
      resolveWorkspaceKanbanCardDropCommitTarget({
        currentTarget: { status: null, isPinDrop: false, dropIndex: 0 },
        latestTrackedTarget: {
          target: { status: 'doing', isPinDrop: false, dropIndex: 2 },
          x: 100,
          y: 100
        },
        x: 140,
        y: 100
      })
    ).toEqual({ status: null, isPinDrop: false, dropIndex: 0 })
  })
})
