import { describe, expect, it } from 'vitest'
import { computeWorktreeSidebarDropPreview } from './worktree-sidebar-drop-preview'
import { holdWorktreeSidebarDragRects } from './worktree-sidebar-drag-geometry'
import {
  refreshWorktreeSidebarDragSession,
  type WorktreeSidebarDragRect
} from './worktree-sidebar-drag-autoscroll'

const GROUP_IDS = ['a', 'b', 'c', 'd', 'e']
const CARD_HEIGHT = 116
const ROW_GAP = 6
// Why: a card with several agent rows expanded runs ~3.5x a collapsed one.
const EXPANDED_CARD_HEIGHT = 404

function layout(heightByWorktreeId: Readonly<Record<string, number>>): WorktreeSidebarDragRect[] {
  let top = 0
  return GROUP_IDS.map((worktreeId, groupIndex) => {
    const height = heightByWorktreeId[worktreeId] ?? CARD_HEIGHT
    const rect = { worktreeId, groupIndex, top, bottom: top + height }
    top += height + ROW_GAP
    return rect
  })
}

const COLLAPSED = layout({})

function previewAt(args: {
  pointerY: number
  rects: readonly WorktreeSidebarDragRect[]
  liveRects?: readonly WorktreeSidebarDragRect[]
}): { dropIndex: number; dropIndicatorY: number } | null {
  const preview = computeWorktreeSidebarDropPreview({
    pointerY: args.pointerY,
    containerTop: 0,
    scrollTop: 0,
    rects: args.rects,
    liveRects: args.liveRects,
    groupIds: GROUP_IDS,
    draggedIds: ['a'],
    draggingWorktreeId: 'a'
  })
  return preview ? { dropIndex: preview.dropIndex, dropIndicatorY: preview.dropIndicatorY } : null
}

describe('worktree sidebar drag geometry under mid-drag card growth', () => {
  it('keeps the drop target fixed while a card expands under a still pointer', () => {
    const pointerY = 250
    const before = previewAt({ pointerY, rects: COLLAPSED })

    // Card 'b' expands its agent list while the pointer does not move at all.
    const grown = layout({ b: EXPANDED_CARD_HEIGHT })
    const liveDropIndex = previewAt({ pointerY, rects: grown })?.dropIndex
    const held = holdWorktreeSidebarDragRects({ held: COLLAPSED, measured: grown })
    const after = previewAt({ pointerY, rects: held, liveRects: grown })

    // Re-measuring live would move the drop target with zero pointer movement.
    expect(liveDropIndex).not.toBe(before?.dropIndex)
    expect(after?.dropIndex).toBe(before?.dropIndex)
  })

  it('never lets a growing card change the drop target across a whole expansion animation', () => {
    const pointerY = 250
    const frames = Array.from({ length: 12 }, (_, frame) =>
      layout({ b: CARD_HEIGHT + ((EXPANDED_CARD_HEIGHT - CARD_HEIGHT) * frame) / 11 })
    )

    const live = frames.map((rects) => previewAt({ pointerY, rects })?.dropIndex)
    const stabilized = frames.map(
      (rects) =>
        previewAt({
          pointerY,
          rects: holdWorktreeSidebarDragRects({ held: COLLAPSED, measured: rects }),
          liveRects: rects
        })?.dropIndex
    )

    expect(new Set(live).size).toBeGreaterThan(1)
    expect(new Set(stabilized)).toEqual(
      new Set([previewAt({ pointerY, rects: COLLAPSED })?.dropIndex])
    )
  })

  it('still tracks the pointer normally while geometry is held', () => {
    const held = holdWorktreeSidebarDragRects({
      held: COLLAPSED,
      measured: layout({ b: EXPANDED_CARD_HEIGHT })
    })

    expect(previewAt({ pointerY: 100, rects: held })?.dropIndex).toBeLessThan(
      previewAt({ pointerY: 500, rects: held })?.dropIndex ?? -1
    )
  })

  it('draws the indicator at the live position so a grown card does not strand it', () => {
    const grown = layout({ b: EXPANDED_CARD_HEIGHT })
    const held = holdWorktreeSidebarDragRects({ held: COLLAPSED, measured: grown })
    const preview = previewAt({ pointerY: 250, rects: held, liveRects: grown })
    const dropIndex = preview?.dropIndex ?? -1

    expect(preview?.dropIndicatorY).toBe(grown[dropIndex]!.top - 3)
    // Held geometry alone would have parked the line ~288px above the real gap.
    expect(preview?.dropIndicatorY).not.toBe(COLLAPSED[dropIndex]!.top - 3)
  })

  it('adopts fresh geometry when rows mount or change slot mid-drag', () => {
    const reordered = COLLAPSED.map((rect, index) => ({
      ...rect,
      worktreeId: GROUP_IDS[(index + 1) % GROUP_IDS.length]!
    }))

    expect(holdWorktreeSidebarDragRects({ held: COLLAPSED, measured: reordered })).toBe(reordered)
    expect(holdWorktreeSidebarDragRects({ held: undefined, measured: COLLAPSED })).toBe(COLLAPSED)
    expect(holdWorktreeSidebarDragRects({ held: [], measured: COLLAPSED })).toBe(COLLAPSED)
  })

  it('holds hit-test geometry across a session refresh while liveRects stay current', () => {
    const grown = layout({ b: EXPANDED_CARD_HEIGHT })
    const refreshed = refreshWorktreeSidebarDragSession({
      session: {
        draggingWorktreeId: 'a',
        sourceGroupKey: 'repo:one',
        draggedIds: ['a'],
        reorderDraggedIds: ['a'],
        reorderUnitDraggedIds: ['a'],
        rects: COLLAPSED,
        liveRects: COLLAPSED
      },
      groups: [{ key: 'repo:one', worktreeIds: GROUP_IDS }],
      unitGroups: [
        {
          key: 'repo:one',
          worktreeIds: GROUP_IDS,
          units: GROUP_IDS.map((worktreeId) => ({ worktreeId, worktreeIds: [worktreeId] }))
        }
      ],
      rects: grown
    })

    expect(refreshed?.rects).toBe(COLLAPSED)
    expect(refreshed?.liveRects).toBe(grown)
  })
})
