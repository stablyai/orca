import type { TabDropZone } from './useTabDragSplit'

/** Matches TabGroupPanel tab row height (`h-[32px]`). */
export const TAB_GROUP_TAB_STRIP_HEIGHT_PX = 32

type PaneRect = { left: number; top: number; width: number; height: number }

export function resolveDropZone(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number }
): TabDropZone {
  const localX = point.x - rect.left
  const localY = point.y - rect.top
  const edgeWidthThreshold = rect.width * 0.1
  const edgeHeightThreshold = rect.height * 0.1
  const splitWidthThreshold = rect.width / 3

  // Why: VS Code keeps a center "merge" zone while biasing side-by-side drops
  // toward left/right, which feels much more stable than a generic nearest-edge
  // calculation once a workspace has nested splits.
  if (
    localX > edgeWidthThreshold &&
    localX < rect.width - edgeWidthThreshold &&
    localY > edgeHeightThreshold &&
    localY < rect.height - edgeHeightThreshold
  ) {
    return 'center'
  }

  if (localX < splitWidthThreshold) {
    return 'left'
  }
  if (localX > splitWidthThreshold * 2) {
    return 'right'
  }
  return localY < rect.height / 2 ? 'up' : 'down'
}

/** Outer band of a split pane panel where drags open another split. */
export function resolvePaneColumnEdgeZone(
  panelRect: PaneRect,
  point: { x: number; y: number },
  options?: {
    bodyRect?: PaneRect | null
    tabStripHeightPx?: number
  }
): Exclude<TabDropZone, 'center'> | null {
  const localX = point.x - panelRect.left
  const horizontalEdge = panelRect.width * 0.2

  if (localX < horizontalEdge) {
    return 'left'
  }
  if (localX > panelRect.width - horizontalEdge) {
    return 'right'
  }

  const tabStripHeight = options?.tabStripHeightPx ?? TAB_GROUP_TAB_STRIP_HEIGHT_PX
  const tabStripBottom = panelRect.top + tabStripHeight
  // Why: the tab strip is for reorder/insertion targets. Vertical pane splits
  // belong on the terminal/editor body edges only.
  if (point.y < tabStripBottom) {
    return null
  }

  const bodyRect =
    options?.bodyRect ??
    ({
      left: panelRect.left,
      top: tabStripBottom,
      width: panelRect.width,
      height: Math.max(0, panelRect.height - tabStripHeight)
    } satisfies PaneRect)

  if (bodyRect.height <= 0) {
    return null
  }

  const bodyLocalY = point.y - bodyRect.top
  const verticalEdge = bodyRect.height * 0.2

  if (bodyLocalY < verticalEdge) {
    return 'up'
  }
  if (bodyLocalY > bodyRect.height - verticalEdge) {
    return 'down'
  }
  return null
}

export type PaneColumnSplitTarget = {
  groupId: string
  zone: Exclude<TabDropZone, 'center'>
}
