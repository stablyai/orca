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
        currentTarget: { status: 'completed', isPinDrop: false },
        currentPreview: preview,
        latestTrackedTarget: {
          target: { status: 'in-progress', isPinDrop: false },
          preview: null,
          x: 100,
          y: 100
        },
        x: 100,
        y: 100
      })
    ).toEqual({
      target: { status: 'completed', isPinDrop: false },
      preview
    })
  })

  it('reuses the latest status target when pointerup hit-testing blanks at the same point', () => {
    expect(
      resolveWorktreeSidebarStatusDropCommitTarget({
        currentTarget: { status: null, isPinDrop: false },
        currentPreview: null,
        latestTrackedTarget: {
          target: { status: 'completed', isPinDrop: false },
          preview,
          x: 100,
          y: 100
        },
        x: 102,
        y: 101
      })
    ).toEqual({
      target: { status: 'completed', isPinDrop: false },
      preview
    })
  })

  it('does not reuse a stale status target after the pointer has moved away', () => {
    expect(
      resolveWorktreeSidebarStatusDropCommitTarget({
        currentTarget: { status: null, isPinDrop: false },
        currentPreview: null,
        latestTrackedTarget: {
          target: { status: 'completed', isPinDrop: false },
          preview,
          x: 100,
          y: 100
        },
        x: 140,
        y: 100
      })
    ).toEqual({
      target: { status: null, isPinDrop: false },
      preview: null
    })
  })
})
