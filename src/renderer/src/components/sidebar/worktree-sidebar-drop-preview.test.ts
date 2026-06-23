import { describe, expect, it } from 'vitest'
import {
  computeWorktreeSidebarDropPreview,
  resolveWorktreeSidebarStatusDropCommitTarget
} from './worktree-sidebar-drop-preview'

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

  it('collapses lineage child rects into the parent drag unit for preview offsets', () => {
    const preview = computeWorktreeSidebarDropPreview({
      pointerY: 430,
      containerTop: 0,
      scrollTop: 0,
      rects: [
        { worktreeId: 'parent', groupIndex: 0, top: 0, bottom: 90 },
        { worktreeId: 'child-a', groupIndex: 1, top: 96, bottom: 186 },
        { worktreeId: 'child-b', groupIndex: 2, top: 192, bottom: 282 },
        { worktreeId: 'sibling', groupIndex: 3, top: 288, bottom: 388 }
      ],
      groupIds: ['parent', 'sibling'],
      draggedIds: ['parent']
    })

    expect(preview).toMatchObject({
      dropIndex: 2,
      dropIndicatorY: 391
    })
    expect(Array.from(preview?.previewOffsetsByWorktreeId ?? [])).toEqual([['sibling', -288]])
  })
})

describe('resolveWorktreeSidebarStatusDropCommitTarget', () => {
  const preview = {
    dropIndex: 1,
    dropIndicatorY: 129,
    previewOffsetsByWorktreeId: new Map<string, number>()
  }

  it('uses the current status target when pointerup hit-testing succeeds', () => {
    expect(
      resolveWorktreeSidebarStatusDropCommitTarget({
        currentTarget: { status: 'completed', isPinDrop: false, lineageParentId: null },
        currentPreview: preview,
        latestTrackedTarget: {
          target: { status: 'in-progress', isPinDrop: false, lineageParentId: null },
          preview: null,
          x: 100,
          y: 100
        },
        x: 100,
        y: 100
      })
    ).toEqual({
      target: { status: 'completed', isPinDrop: false, lineageParentId: null },
      preview
    })
  })

  it('reuses the latest status target when pointerup hit-testing blanks at the same point', () => {
    expect(
      resolveWorktreeSidebarStatusDropCommitTarget({
        currentTarget: { status: null, isPinDrop: false, lineageParentId: null },
        currentPreview: null,
        latestTrackedTarget: {
          target: { status: 'completed', isPinDrop: false, lineageParentId: null },
          preview,
          x: 100,
          y: 100
        },
        x: 102,
        y: 101
      })
    ).toEqual({
      target: { status: 'completed', isPinDrop: false, lineageParentId: null },
      preview
    })
  })

  it('reuses the latest lineage target when pointerup hit-testing blanks at the same point', () => {
    expect(
      resolveWorktreeSidebarStatusDropCommitTarget({
        currentTarget: { status: null, isPinDrop: false, lineageParentId: null },
        currentPreview: null,
        latestTrackedTarget: {
          target: { status: null, isPinDrop: false, lineageParentId: 'parent-worktree' },
          preview: null,
          x: 100,
          y: 100
        },
        x: 102,
        y: 101
      })
    ).toEqual({
      target: { status: null, isPinDrop: false, lineageParentId: 'parent-worktree' },
      preview: null
    })
  })

  it('does not reuse a stale status target after the pointer has moved away', () => {
    expect(
      resolveWorktreeSidebarStatusDropCommitTarget({
        currentTarget: { status: null, isPinDrop: false, lineageParentId: null },
        currentPreview: null,
        latestTrackedTarget: {
          target: { status: 'completed', isPinDrop: false, lineageParentId: null },
          preview,
          x: 100,
          y: 100
        },
        x: 140,
        y: 100
      })
    ).toEqual({
      target: { status: null, isPinDrop: false, lineageParentId: null },
      preview: null
    })
  })
})
