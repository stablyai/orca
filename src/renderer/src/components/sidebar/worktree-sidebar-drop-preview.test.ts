import { describe, expect, it } from 'vitest'
import { computeWorktreeSidebarDropPreview } from './worktree-sidebar-drop-preview'

const rects = [
  { worktreeId: 'done-a', groupIndex: 0, top: 80, bottom: 120 },
  { worktreeId: 'done-b', groupIndex: 1, top: 132, bottom: 172 }
]

describe('computeWorktreeSidebarDropPreview', () => {
  it('computes an insertion line for a target group', () => {
    expect(
      computeWorktreeSidebarDropPreview({
        pointerY: 151,
        containerTop: 100,
        scrollTop: 100,
        rects,
        groupIds: ['done-a', 'done-b'],
        draggedIds: ['in-progress-a']
      })
    ).toMatchObject({
      dropIndex: 1,
      dropIndicatorY: 129
    })
  })

  it('returns null outside the group boundary', () => {
    expect(
      computeWorktreeSidebarDropPreview({
        pointerY: -20,
        containerTop: 100,
        scrollTop: 100,
        rects,
        groupIds: ['done-a', 'done-b'],
        draggedIds: ['in-progress-a']
      })
    ).toBeNull()
  })
})
