import { describe, expect, it } from 'vitest'
import { resolveWorkspaceStatusDropTargetFromRects } from './workspace-kanban-card-pointer-drag-dom'

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
