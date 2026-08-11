import { describe, expect, it } from 'vitest'

import {
  getHeaderRowRenderedTop,
  getHeaderRowTransformStart,
  getPinnedHeaderTopOffsetPx,
  PINNED_HEADER_TOP_OFFSET_PX,
  PINNED_HEADER_TOP_OFFSET_UNDER_HOST_PX,
  type HeaderRowPositionArgs
} from './worktree-list-header-row-position'
import { SECONDARY_GROUP_HEADER_TOP_MARGIN } from './worktree-list-virtual-rows'

// A section the user has scrolled well into: its header row starts at 400 in
// content space but renders at the pinned slot near 900.
const SCROLLED_INTO_SECTION: HeaderRowPositionArgs = {
  virtualStart: 400,
  isPinned: true,
  scrollOffset: 900,
  pinnedTopOffsetPx: PINNED_HEADER_TOP_OFFSET_PX,
  headerTopSpacingPx: SECONDARY_GROUP_HEADER_TOP_MARGIN,
  dragAnchorTop: null,
  offsetY: 0
}

/** The promotion frame: the header has left the sticky slot and is drawn by the
 *  absolute branch, anchored to where the pointerdown found it. */
function promote(before: HeaderRowPositionArgs, offsetY: number): HeaderRowPositionArgs {
  return {
    ...before,
    isPinned: false,
    dragAnchorTop: getHeaderRowRenderedTop(before),
    offsetY
  }
}

describe('dragged project header anchor', () => {
  it('does not move a pinned header on the frame the drag promotes', () => {
    const beforePromotion = getHeaderRowRenderedTop(SCROLLED_INTO_SECTION)
    // Guards against a vacuous pass: the pinned slot has to be genuinely far
    // from the header's virtual start, which is what a jump would expose.
    expect(beforePromotion - SCROLLED_INTO_SECTION.virtualStart).toBe(499)

    expect(getHeaderRowRenderedTop(promote(SCROLLED_INTO_SECTION, 0))).toBe(beforePromotion)
  })

  it('keeps a pinned header under the cursor for the rest of the drag', () => {
    const beforePromotion = getHeaderRowRenderedTop(SCROLLED_INTO_SECTION)

    expect(getHeaderRowRenderedTop(promote(SCROLLED_INTO_SECTION, 30))).toBe(beforePromotion + 30)
  })

  it('leaves a header that was not pinned exactly where it was', () => {
    const inFlow = { ...SCROLLED_INTO_SECTION, isPinned: false }
    const beforePromotion = getHeaderRowRenderedTop(inFlow)

    expect(getHeaderRowRenderedTop(promote(inFlow, 0))).toBe(beforePromotion)
    // The transform sits above the padding that re-adds the section spacing, so
    // an undragged in-flow header still translates by its plain virtual start.
    expect(getHeaderRowTransformStart(inFlow)).toBe(inFlow.virtualStart)
  })

  it('anchors to the slot beneath a pinned host card when one owns tier 1', () => {
    const underHost: HeaderRowPositionArgs = {
      ...SCROLLED_INTO_SECTION,
      pinnedTopOffsetPx: getPinnedHeaderTopOffsetPx(true)
    }

    expect(getHeaderRowRenderedTop(underHost)).toBe(
      underHost.scrollOffset + PINNED_HEADER_TOP_OFFSET_UNDER_HOST_PX
    )
    expect(getHeaderRowRenderedTop(promote(underHost, 0))).toBe(getHeaderRowRenderedTop(underHost))
  })

  it('shifts an undragged neighbour by its preview offset', () => {
    const neighbour = { ...SCROLLED_INTO_SECTION, isPinned: false, offsetY: -28 }

    expect(getHeaderRowTransformStart(neighbour)).toBe(neighbour.virtualStart - 28)
  })
})
