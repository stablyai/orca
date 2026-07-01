import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/types'
import { getLineageDragOutWorktreeIds } from './worktree-lineage-drag-out'
import type { WorktreeSidebarDragRect } from './worktree-sidebar-drag-autoscroll'

function lineage(parentWorktreeId: string): WorktreeLineage {
  return {
    worktreeId: 'child',
    worktreeInstanceId: 'child-instance',
    parentWorktreeId,
    parentWorktreeInstanceId: `${parentWorktreeId}-instance`,
    origin: 'manual',
    capture: {
      source: 'manual-action',
      confidence: 'explicit'
    },
    createdAt: Date.now()
  }
}

function rect(worktreeId: string, top: number, bottom: number): WorktreeSidebarDragRect {
  return { worktreeId, groupIndex: 0, top, bottom }
}

describe('getLineageDragOutWorktreeIds', () => {
  it('detaches a child when dropped outside its current parent bounds', () => {
    expect(
      getLineageDragOutWorktreeIds({
        draggedIds: ['child'],
        lineageById: { child: lineage('parent') },
        rects: [rect('parent', 100, 260), rect('child', 160, 220)],
        localY: 280
      })
    ).toEqual(['child'])
  })

  it('keeps a child parented while the drop remains inside the parent bounds', () => {
    expect(
      getLineageDragOutWorktreeIds({
        draggedIds: ['child'],
        lineageById: { child: lineage('parent') },
        rects: [rect('parent', 100, 260), rect('child', 160, 220)],
        localY: 200
      })
    ).toEqual([])
  })

  it('ignores root worktrees and missing parent rects', () => {
    expect(
      getLineageDragOutWorktreeIds({
        draggedIds: ['root', 'hidden-child'],
        lineageById: { 'hidden-child': lineage('missing-parent') },
        rects: [rect('root', 0, 80)],
        localY: 120
      })
    ).toEqual([])
  })
})
