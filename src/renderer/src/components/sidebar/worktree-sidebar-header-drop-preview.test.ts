import { describe, expect, it } from 'vitest'
import {
  buildSidebarHeaderPreviewOffsets,
  computeWorktreeSidebarHeaderDropPreview,
  type WorktreeSidebarHeaderDragRect
} from './worktree-sidebar-header-drop-preview'

const IDS = ['a', 'b', 'c', 'd']
const SECTION_HEIGHT = 116

function offsets(draggedId: string, dropIndex: number): Record<string, number> {
  return Object.fromEntries(
    buildSidebarHeaderPreviewOffsets({
      orderedIds: IDS,
      draggedId,
      dropIndex,
      sectionHeight: SECTION_HEIGHT
    })
  )
}

describe('buildSidebarHeaderPreviewOffsets', () => {
  it('shifts passed sections up when dragging down', () => {
    // 'a' (index 0) dropped at slot 3 passes 'b' and 'c'.
    expect(offsets('a', 3)).toEqual({ b: -SECTION_HEIGHT, c: -SECTION_HEIGHT })
  })

  it('shifts passed sections down when dragging up', () => {
    // 'd' (index 3) dropped at slot 1 passes 'b' and 'c'.
    expect(offsets('d', 1)).toEqual({ b: SECTION_HEIGHT, c: SECTION_HEIGHT })
  })

  it('returns an empty map for a no-op drop', () => {
    // Both the own index and one past it leave the order unchanged.
    expect(offsets('b', 1)).toEqual({})
    expect(offsets('b', 2)).toEqual({})
  })

  it('handles drops clamped at both ends', () => {
    expect(offsets('d', 0)).toEqual({ a: SECTION_HEIGHT, b: SECTION_HEIGHT, c: SECTION_HEIGHT })
    expect(offsets('a', IDS.length)).toEqual({
      b: -SECTION_HEIGHT,
      c: -SECTION_HEIGHT,
      d: -SECTION_HEIGHT
    })
  })

  it('returns an empty map when the dragged id is not in the list', () => {
    expect(offsets('missing', 2)).toEqual({})
  })

  it('never includes the dragged project itself', () => {
    expect(offsets('a', 3)).not.toHaveProperty('a')
  })
})

// pickNearestHeaderBoundarySlot (the interior-gap fallback for #6609) is exercised
// through computeWorktreeSidebarHeaderDropPreview here, asserting dropIndicatorY
// directly. With only two headers afterPrev.dropIndex and beforeNext.dropIndex are
// always equal by construction, so a project-header-drop.test.ts-style assertion on
// dropIndex/previewOffsetsByRepoId alone cannot tell the two boundary choices apart;
// dropIndicatorY is the only observable that discriminates them.
describe('computeWorktreeSidebarHeaderDropPreview — interior-gap boundary snap', () => {
  const INDICATOR_GAP = 4
  const prevSectionBottom = 200
  const nextHeaderTop = 240
  const prevBoundaryY = prevSectionBottom + INDICATOR_GAP // 204
  const nextBoundaryY = nextHeaderTop - INDICATOR_GAP // 236
  const midpointY = (prevBoundaryY + nextBoundaryY) / 2 // 220

  type Rect = WorktreeSidebarHeaderDragRect & { id: string }
  const rects: Rect[] = [
    { id: 'a', headerIndex: 0, top: 100, bottom: 128, sectionBottom: prevSectionBottom },
    { id: 'b', headerIndex: 1, top: nextHeaderTop, bottom: 268 }
  ]

  const previewAt = (pointerY: number) =>
    computeWorktreeSidebarHeaderDropPreview({
      pointerY,
      containerTop: 0,
      scrollTop: 0,
      rects,
      headerCount: 2,
      getId: (rect) => rect.id
    })

  it('snaps to the previous header boundary when the pointer sits nearer it', () => {
    // 205 sits in the gap between 'a' and 'b', closer to 204 than to 236.
    expect(previewAt(prevBoundaryY + 1)).toEqual({
      dropIndex: 1,
      dropIndicatorY: prevBoundaryY,
      dropSlotY: prevSectionBottom
    })
  })

  it('snaps to the next header boundary when the pointer sits nearer it', () => {
    // 235 sits in the gap between 'a' and 'b', closer to 236 than to 204.
    expect(previewAt(nextBoundaryY - 1)).toEqual({
      dropIndex: 1,
      dropIndicatorY: nextBoundaryY,
      dropSlotY: nextHeaderTop
    })
  })

  it('breaks an exact midpoint tie toward the next header boundary', () => {
    // worktree-sidebar-header-drop-preview.ts:138 documents ties resolving to
    // the next header's boundary.
    expect(previewAt(midpointY)).toEqual({
      dropIndex: 1,
      dropIndicatorY: nextBoundaryY,
      dropSlotY: nextHeaderTop
    })
  })
})
