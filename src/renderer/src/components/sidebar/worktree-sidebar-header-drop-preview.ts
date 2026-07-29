import { getWorktreeSidebarBoundaryDrop } from './worktree-sidebar-drag-autoscroll'

export type WorktreeSidebarHeaderDragRect = {
  headerIndex: number
  top: number
  bottom: number
  sectionBottom?: number
}

export type WorktreeSidebarHeaderDropPreview = {
  dropIndex: number
  dropIndicatorY: number
}

const INDICATOR_GAP_PX = 4

export function computeWorktreeSidebarHeaderDropPreview<
  TRect extends WorktreeSidebarHeaderDragRect
>(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  rects: readonly TRect[]
  headerCount: number
  getId: (rect: TRect) => string
  // Measured scroll-content height (same coordinate space as localY and the
  // virtualizer-derived rect tops). Bounds the interior snap so it cannot
  // fabricate a slot below the real list end. Optional: geometry-only unit
  // tests omit it; live drags always pass container.scrollHeight.
  contentBottom?: number
}): WorktreeSidebarHeaderDropPreview | null {
  if (args.rects.length === 0 || args.headerCount === 0) {
    return null
  }

  const localY = args.pointerY - args.containerTop + args.scrollTop
  // Why: every preview branch, including estimated edge slots, must stay
  // inside the measured list content rather than fabricate a reorder below it.
  if (args.contentBottom !== undefined && localY > args.contentBottom) {
    return null
  }
  const first = args.rects[0]!
  const last = args.rects.at(-1)!
  const lastBoundaryBottom = Math.max(last.bottom, last.sectionBottom ?? last.bottom)
  const boundaryDrop = getWorktreeSidebarBoundaryDrop({
    localY,
    firstRect: {
      worktreeId: args.getId(first),
      groupIndex: first.headerIndex,
      top: first.top,
      bottom: first.bottom
    },
    lastRect: {
      worktreeId: args.getId(last),
      groupIndex: last.headerIndex,
      top: last.top,
      bottom: lastBoundaryBottom
    },
    sourceGroupSize: args.headerCount
  })
  if (boundaryDrop.kind === 'outside') {
    return null
  }
  if (boundaryDrop.kind === 'drop') {
    return {
      dropIndex: boundaryDrop.dropIndex,
      dropIndicatorY: Math.max(args.scrollTop, boundaryDrop.indicatorY)
    }
  }

  const hoveredRect = args.rects.find((rect) => localY >= rect.top && localY <= rect.bottom)
  if (hoveredRect) {
    const mid = (hoveredRect.top + hoveredRect.bottom) / 2
    const dropIndex = localY < mid ? hoveredRect.headerIndex : hoveredRect.headerIndex + 1
    const nextRect =
      localY < mid ? hoveredRect : args.rects.find((rect) => rect.headerIndex >= dropIndex)
    const indicatorY = nextRect
      ? Math.max(0, nextRect.top - INDICATOR_GAP_PX)
      : Math.max(hoveredRect.bottom, hoveredRect.sectionBottom ?? hoveredRect.bottom) +
        INDICATOR_GAP_PX

    return {
      dropIndex,
      dropIndicatorY: Math.max(args.scrollTop, indicatorY)
    }
  }

  // localY is in a section body or interior gap, not a header band. Snap to the
  // nearer boundary slot instead of returning null: this interior dead zone was
  // accidental scope of 22d5989ed (#6609 only required correct reorder indices),
  // and vanishing here makes the drop a silent no-op.
  const boundary = pickNearestHeaderBoundarySlot(args.rects, localY)
  if (!boundary) {
    return null
  }
  return {
    dropIndex: boundary.dropIndex,
    dropIndicatorY: Math.max(args.scrollTop, boundary.indicatorY)
  }
}

type WorktreeSidebarHeaderBoundarySlot = {
  dropIndex: number
  indicatorY: number
}

function pickNearestHeaderBoundarySlot(
  rects: readonly WorktreeSidebarHeaderDragRect[],
  localY: number
): WorktreeSidebarHeaderBoundarySlot | null {
  let prevRect: WorktreeSidebarHeaderDragRect | undefined
  let nextRect: WorktreeSidebarHeaderDragRect | undefined
  for (const rect of rects) {
    if (rect.top <= localY) {
      prevRect = rect
    } else if (nextRect === undefined) {
      nextRect = rect
    }
  }

  const afterPrev: WorktreeSidebarHeaderBoundarySlot | null = prevRect
    ? {
        dropIndex: prevRect.headerIndex + 1,
        indicatorY:
          Math.max(prevRect.bottom, prevRect.sectionBottom ?? prevRect.bottom) + INDICATOR_GAP_PX
      }
    : null
  const beforeNext: WorktreeSidebarHeaderBoundarySlot | null = nextRect
    ? { dropIndex: nextRect.headerIndex, indicatorY: Math.max(0, nextRect.top - INDICATOR_GAP_PX) }
    : null

  if (!afterPrev) {
    return beforeNext
  }
  if (!beforeNext) {
    return afterPrev
  }
  // Ties (localY at the span midpoint) resolve to the next header's boundary.
  return Math.abs(localY - beforeNext.indicatorY) <= Math.abs(localY - afterPrev.indicatorY)
    ? beforeNext
    : afterPrev
}
