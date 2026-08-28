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

    // Sibling slides up to 0 and the 282px-tall parent unit lands right after it,
    // so the line marks 106 - 3. The old rule pointed at the sibling's stale
    // bottom (391), a full lineage-height below where the card actually lands.
    expect(preview).toMatchObject({
      dropIndex: 2,
      dropIndicatorY: 103
    })
    expect(Array.from(preview?.previewOffsetsByWorktreeId ?? [])).toEqual([['sibling', -288]])
  })

  it('uses one card-height placeholder for multi-select reorder previews', () => {
    const preview = computeWorktreeSidebarDropPreview({
      pointerY: 280,
      containerTop: 0,
      scrollTop: 0,
      rects: [
        { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 50 },
        { worktreeId: 'b', groupIndex: 1, top: 56, bottom: 106 },
        { worktreeId: 'c', groupIndex: 2, top: 112, bottom: 162 },
        { worktreeId: 'd', groupIndex: 3, top: 168, bottom: 218 },
        { worktreeId: 'e', groupIndex: 4, top: 224, bottom: 274 }
      ],
      groupIds: ['a', 'b', 'c', 'd', 'e'],
      draggedIds: ['b', 'c', 'd'],
      draggingWorktreeId: 'b'
    })

    // c/d/e slide up one slot, so the placeholder opens at 224 and the line marks
    // 221 — not 277, which was one whole card height below the real gap.
    expect(preview).toMatchObject({
      dropIndex: 5,
      dropIndicatorY: 221
    })
    expect(Array.from(preview?.previewOffsetsByWorktreeId ?? [])).toEqual([
      ['c', -56],
      ['d', -56],
      ['e', -56]
    ])
  })

  it('uses the grabbed selected card as the multi-select preview placeholder', () => {
    const preview = computeWorktreeSidebarDropPreview({
      pointerY: 280,
      containerTop: 0,
      scrollTop: 0,
      rects: [
        { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 50 },
        { worktreeId: 'b', groupIndex: 1, top: 56, bottom: 106 },
        { worktreeId: 'c', groupIndex: 2, top: 112, bottom: 162 },
        { worktreeId: 'd', groupIndex: 3, top: 168, bottom: 218 },
        { worktreeId: 'e', groupIndex: 4, top: 224, bottom: 274 }
      ],
      groupIds: ['a', 'b', 'c', 'd', 'e'],
      draggedIds: ['b', 'c', 'd'],
      draggingWorktreeId: 'd'
    })

    expect(preview).toMatchObject({
      dropIndex: 5,
      dropIndicatorY: 221
    })
    expect(Array.from(preview?.previewOffsetsByWorktreeId ?? [])).toEqual([['e', -56]])
  })

  it('marks the gap the row previews open, not the displaced card top', () => {
    // One expanded agent card (404px) among collapsed ones: dragging 'a' below it
    // is exactly the case where the old rule put the line a card-height off.
    const rects = [
      { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 116 },
      { worktreeId: 'b', groupIndex: 1, top: 122, bottom: 238 },
      { worktreeId: 'expanded', groupIndex: 2, top: 244, bottom: 648 },
      { worktreeId: 'd', groupIndex: 3, top: 654, bottom: 770 }
    ]
    const groupIds = ['a', 'b', 'expanded', 'd']
    const preview = computeWorktreeSidebarDropPreview({
      pointerY: 700,
      containerTop: 0,
      scrollTop: 0,
      rects,
      groupIds,
      draggedIds: ['a'],
      draggingWorktreeId: 'a',
      grab: { offsetY: 58, height: 116 }
    })!

    // 'a' lands last, so every other card slides up by its 116px + 6px gap.
    const offsets = preview.previewOffsetsByWorktreeId
    expect(offsets.get('b')).toBe(-122)
    expect(offsets.get('expanded')).toBe(-122)
    expect(offsets.get('d')).toBe(-122)
    // d ends at 532..648, so a's slot opens at 654 and the line marks 651.
    expect(preview.dropIndicatorY).toBe(651)
    // The old rule had no rect at this index and fell back to the pre-drag list
    // bottom (773) — 122px below the gap the user could see opening.
  })

  it('resolves the same slot wherever a tall card is grabbed', () => {
    const rects = [
      { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 116 },
      { worktreeId: 'b', groupIndex: 1, top: 122, bottom: 238 },
      { worktreeId: 'expanded', groupIndex: 2, top: 244, bottom: 648 }
    ]
    const groupIds = ['a', 'b', 'expanded']
    const height = 404
    const dropIndexes = [0.05, 0.5, 0.95].map((fraction) => {
      const offsetY = height * fraction
      return computeWorktreeSidebarDropPreview({
        pointerY: 122 + offsetY,
        containerTop: 0,
        scrollTop: 0,
        rects,
        groupIds,
        draggedIds: ['expanded'],
        draggingWorktreeId: 'expanded',
        grab: { offsetY, height }
      })!.dropIndex
    })

    expect(new Set(dropIndexes).size).toBe(1)
  })

  it('keeps a downward end drop stable when leading rows are virtualized', () => {
    const groupIds = ['a', 'b', 'c', 'd', 'e', 'f']
    const mountedRects = [
      { worktreeId: 'd', groupIndex: 3, top: 168, bottom: 218 },
      { worktreeId: 'e', groupIndex: 4, top: 224, bottom: 274 },
      { worktreeId: 'f', groupIndex: 5, top: 280, bottom: 330 }
    ]
    const input = {
      pointerY: 320,
      containerTop: 0,
      scrollTop: 0,
      rects: mountedRects,
      groupIds,
      draggedIds: ['a'],
      draggingWorktreeId: 'a',
      grab: { offsetY: 25, height: 50 }
    }

    const first = computeWorktreeSidebarDropPreview(input)!
    const held = computeWorktreeSidebarDropPreview({
      ...input,
      anchor: { beforeWorktreeId: first.dropAnchorId, pointerY: 320, scrollTop: 0 }
    })!

    for (const preview of [first, held]) {
      expect(preview).toMatchObject({
        dropIndex: 6,
        dropIndicatorY: 277,
        dropAnchorId: null
      })
      expect(Array.from(preview.previewOffsetsByWorktreeId)).toEqual([
        ['d', -56],
        ['e', -56],
        ['f', -56]
      ])
    }
  })

  it('uses the full group index when the dragged row is outside the mounted window', () => {
    const preview = computeWorktreeSidebarDropPreview({
      pointerY: 193,
      containerTop: 0,
      scrollTop: 0,
      rects: [
        { worktreeId: 'd', groupIndex: 3, top: 168, bottom: 218 },
        { worktreeId: 'e', groupIndex: 4, top: 224, bottom: 274 },
        { worktreeId: 'f', groupIndex: 5, top: 280, bottom: 330 }
      ],
      groupIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      draggedIds: ['e'],
      draggingWorktreeId: 'e',
      grab: { offsetY: 25, height: 50 }
    })

    expect(preview?.dropIndex).toBe(3)
  })

  it('preserves the virtual row gap when only one row remains mounted', () => {
    const preview = computeWorktreeSidebarDropPreview({
      pointerY: 305,
      containerTop: 0,
      scrollTop: 0,
      rects: [{ worktreeId: 'f', groupIndex: 5, top: 280, bottom: 330 }],
      groupIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      draggedIds: ['a'],
      draggingWorktreeId: 'a',
      fallbackGap: 6,
      grab: { offsetY: 25, height: 50 }
    })

    expect(preview).toMatchObject({ dropIndex: 6, dropIndicatorY: 277 })
    expect(Array.from(preview?.previewOffsetsByWorktreeId ?? [])).toEqual([['f', -56]])
  })
})

describe('resolveWorktreeSidebarStatusDropCommitTarget', () => {
  const preview = {
    dropIndex: 1,
    dropIndicatorY: 129,
    previewOffsetsByWorktreeId: new Map<string, number>(),
    dropAnchorId: null
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
