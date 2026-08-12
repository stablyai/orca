import { describe, expect, it } from 'vitest'
import { computeWorktreeSidebarDropPreview } from './worktree-sidebar-drop-preview'
import {
  getWorktreeSidebarDragGrab,
  getWorktreeSidebarDragReferenceY,
  resolveWorktreeSidebarDropAnchorIndex,
  shouldReevaluateWorktreeSidebarDropAnchor,
  type WorktreeSidebarDropAnchor
} from './worktree-sidebar-drag-geometry'
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
const GRAB = { offsetY: CARD_HEIGHT / 2, height: CARD_HEIGHT }

function previewAt(args: {
  pointerY: number
  rects: readonly WorktreeSidebarDragRect[]
  anchor?: WorktreeSidebarDropAnchor | null
  draggingWorktreeId?: string
  grab?: { offsetY: number; height: number } | null
}) {
  return computeWorktreeSidebarDropPreview({
    pointerY: args.pointerY,
    containerTop: 0,
    scrollTop: 0,
    rects: args.rects,
    groupIds: GROUP_IDS,
    draggedIds: [args.draggingWorktreeId ?? 'a'],
    draggingWorktreeId: args.draggingWorktreeId ?? 'a',
    grab: args.grab === undefined ? GRAB : args.grab,
    anchor: args.anchor
  })
}

/**
 * Replay a drag where the pointer never moves while a card animates open, holding
 * the drop decision across frames exactly as the live drag loop does.
 */
function replayStillPointer(args: {
  pointerY: number
  frames: readonly (readonly WorktreeSidebarDragRect[])[]
}): { dropIndexes: number[]; indicatorYs: number[] } {
  let anchor: WorktreeSidebarDropAnchor | null = null
  const dropIndexes: number[] = []
  const indicatorYs: number[] = []
  for (const rects of args.frames) {
    const held = shouldReevaluateWorktreeSidebarDropAnchor({
      anchor,
      pointerY: args.pointerY,
      scrollTop: 0
    })
      ? null
      : anchor
    const preview = previewAt({ pointerY: args.pointerY, rects, anchor: held })!
    anchor = { beforeWorktreeId: preview.dropAnchorId, pointerY: args.pointerY, scrollTop: 0 }
    dropIndexes.push(preview.dropIndex)
    indicatorYs.push(preview.dropIndicatorY)
  }
  return { dropIndexes, indicatorYs }
}

describe('worktree sidebar drag geometry under mid-drag card growth', () => {
  it('keeps the drop target fixed while a card expands under a still pointer', () => {
    const pointerY = 250
    const grown = layout({ b: EXPANDED_CARD_HEIGHT })

    const unheld = previewAt({ pointerY, rects: grown })!.dropIndex
    const { dropIndexes } = replayStillPointer({ pointerY, frames: [COLLAPSED, grown] })

    // Re-deciding from the grown layout would move the target with zero input.
    expect(unheld).not.toBe(dropIndexes[0])
    expect(dropIndexes[1]).toBe(dropIndexes[0])
  })

  it('never lets a growing card change the drop target across a whole expansion', () => {
    const frames = Array.from({ length: 12 }, (_, frame) =>
      layout({ b: CARD_HEIGHT + ((EXPANDED_CARD_HEIGHT - CARD_HEIGHT) * frame) / 11 })
    )

    for (const pointerY of [150, 250, 350, 450, 550]) {
      const unheld = frames.map((rects) => previewAt({ pointerY, rects })!.dropIndex)
      const { dropIndexes } = replayStillPointer({ pointerY, frames })

      expect(new Set(dropIndexes).size).toBe(1)
      // The scenario has to be one that actually moves without the hold.
      if (pointerY !== 150) {
        expect(new Set(unheld).size).toBeGreaterThan(1)
      }
    }
  })

  it('slides the indicator with the gap it marks while geometry is held', () => {
    const frames = Array.from({ length: 12 }, (_, frame) =>
      layout({ b: CARD_HEIGHT + ((EXPANDED_CARD_HEIGHT - CARD_HEIGHT) * frame) / 11 })
    )
    const { dropIndexes, indicatorYs } = replayStillPointer({ pointerY: 350, frames })

    expect(new Set(dropIndexes).size).toBe(1)
    // Held decision, live rendering: the line tracks the growing card, never freezes.
    expect(indicatorYs.at(-1)!).toBeGreaterThan(indicatorYs[0]!)
    expect(new Set(indicatorYs).size).toBe(frames.length)
  })

  it('still tracks the pointer normally once it moves again', () => {
    const grown = layout({ b: EXPANDED_CARD_HEIGHT })

    expect(previewAt({ pointerY: 100, rects: grown })!.dropIndex).toBeLessThan(
      previewAt({ pointerY: 800, rects: grown })!.dropIndex
    )
  })

  it('re-evaluates on real pointer or scroll movement but not on jitter', () => {
    const anchor: WorktreeSidebarDropAnchor = {
      beforeWorktreeId: 'c',
      pointerY: 250,
      scrollTop: 40
    }

    expect(
      shouldReevaluateWorktreeSidebarDropAnchor({ anchor, pointerY: 250, scrollTop: 40 })
    ).toBe(false)
    expect(
      shouldReevaluateWorktreeSidebarDropAnchor({ anchor, pointerY: 250.2, scrollTop: 40 })
    ).toBe(false)
    expect(
      shouldReevaluateWorktreeSidebarDropAnchor({ anchor, pointerY: 254, scrollTop: 40 })
    ).toBe(true)
    expect(
      shouldReevaluateWorktreeSidebarDropAnchor({ anchor, pointerY: 250, scrollTop: 88 })
    ).toBe(true)
    expect(
      shouldReevaluateWorktreeSidebarDropAnchor({ anchor: null, pointerY: 250, scrollTop: 40 })
    ).toBe(true)
  })

  it('falls back to a fresh decision when the anchored card disappears mid-drag', () => {
    const anchor: WorktreeSidebarDropAnchor = {
      beforeWorktreeId: 'gone',
      pointerY: 250,
      scrollTop: 0
    }

    expect(resolveWorktreeSidebarDropAnchorIndex({ anchor, rects: COLLAPSED })).toBeNull()
    expect(
      resolveWorktreeSidebarDropAnchorIndex({
        anchor: { beforeWorktreeId: 'c', pointerY: 0, scrollTop: 0 },
        rects: COLLAPSED
      })
    ).toBe(2)
    // A null anchor id means end-of-group, which survives any row count change.
    expect(
      resolveWorktreeSidebarDropAnchorIndex({
        anchor: { beforeWorktreeId: null, pointerY: 0, scrollTop: 0 },
        rects: COLLAPSED
      })
    ).toBe(COLLAPSED.length)
  })

  it('keeps one live coordinate space across a session refresh', () => {
    const grown = layout({ b: EXPANDED_CARD_HEIGHT })
    const refreshed = refreshWorktreeSidebarDragSession({
      session: {
        draggingWorktreeId: 'a',
        sourceGroupKey: 'repo:one',
        draggedIds: ['a'],
        reorderDraggedIds: ['a'],
        reorderUnitDraggedIds: ['a'],
        rects: COLLAPSED,
        grab: GRAB,
        anchor: null
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

    expect(refreshed?.rects).toBe(grown)
    expect(refreshed?.grab).toBe(GRAB)
  })
})

describe('grab-relative hit testing', () => {
  it('projects the dragged card from the pointer instead of using the bare pointer', () => {
    const activeRect = { worktreeId: 'a', groupIndex: 0, top: 0, bottom: CARD_HEIGHT }

    // Grabbed at the very top edge: the card sits below the pointer.
    expect(
      getWorktreeSidebarDragReferenceY({
        localY: 300,
        grab: { offsetY: 0, height: CARD_HEIGHT },
        activeRect
      })
    ).toBe(300 + CARD_HEIGHT / 2)
    // Grabbed at the bottom edge: the card sits above the pointer.
    expect(
      getWorktreeSidebarDragReferenceY({
        localY: 300,
        grab: { offsetY: CARD_HEIGHT, height: CARD_HEIGHT },
        activeRect
      })
    ).toBe(300 - CARD_HEIGHT / 2)
    // No grab (native HTML5 drag) degrades to the raw pointer.
    expect(getWorktreeSidebarDragReferenceY({ localY: 300, grab: null, activeRect })).toBe(300)
  })

  it('resolves the same slot wherever a tall card was grabbed', () => {
    const rects = layout({ c: EXPANDED_CARD_HEIGHT })
    const tall = rects.find((rect) => rect.worktreeId === 'c')!
    const height = tall.bottom - tall.top
    // Park the card so it visually occupies b's slot, varying only the grab point.
    const slotTop = rects[1]!.top

    const dropIndexes = [0.05, 0.25, 0.5, 0.75, 0.95].map((fraction) => {
      const offsetY = height * fraction
      return previewAt({
        pointerY: slotTop + offsetY,
        rects,
        draggingWorktreeId: 'c',
        grab: { offsetY, height }
      })!.dropIndex
    })

    expect(new Set(dropIndexes).size).toBe(1)
  })

  it('clamps a grab offset that lands outside the card', () => {
    expect(getWorktreeSidebarDragGrab({ offsetY: -40, height: CARD_HEIGHT })).toEqual({
      offsetY: 0,
      height: CARD_HEIGHT
    })
    expect(getWorktreeSidebarDragGrab({ offsetY: 900, height: CARD_HEIGHT })).toEqual({
      offsetY: CARD_HEIGHT,
      height: CARD_HEIGHT
    })
    expect(getWorktreeSidebarDragGrab({ offsetY: 10, height: 0 })).toBeNull()
    expect(getWorktreeSidebarDragGrab({ offsetY: Number.NaN, height: CARD_HEIGHT })).toBeNull()
  })
})
