import { describe, expect, it } from 'vitest'
import {
  resolveWorkspaceKanbanCardDropCommitTarget,
  resolveWorkspaceCardDropIndexFromRects,
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
