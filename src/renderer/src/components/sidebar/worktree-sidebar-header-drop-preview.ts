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
}): WorktreeSidebarHeaderDropPreview | null {
  if (args.rects.length === 0 || args.headerCount === 0) {
    return null
  }

  const localY = args.pointerY - args.containerTop + args.scrollTop
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
  if (!hoveredRect) {
    return null
  }

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
