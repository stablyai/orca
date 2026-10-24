import type { TabDropZone } from './tab-drag-data'

/** Matches TabGroupPanel tab row height (`h-[32px]`). */
export const TAB_GROUP_TAB_STRIP_HEIGHT_PX = 32

export type PaneRect = { left: number; top: number; width: number; height: number }

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

/** The part of a panel left after the Level 1 band: leaf drops live only here. */
export function paneColumnInteriorRect(
  panelRect: PaneRect,
  options?: { bodyRect?: PaneRect | null; tabStripHeightPx?: number }
): PaneRect | null {
  const tabStripHeight = options?.tabStripHeightPx ?? TAB_GROUP_TAB_STRIP_HEIGHT_PX
  const bodyRect = options?.bodyRect ?? {
    left: panelRect.left,
    top: panelRect.top + tabStripHeight,
    width: panelRect.width,
    height: Math.max(0, panelRect.height - tabStripHeight)
  }
  if (bodyRect.height <= 0 || panelRect.width <= 0) {
    return null
  }
  const horizontalEdge = panelRect.width * 0.2
  const verticalEdge = bodyRect.height * 0.2
  return {
    left: panelRect.left + horizontalEdge,
    top: bodyRect.top + verticalEdge,
    width: panelRect.width - horizontalEdge * 2,
    height: bodyRect.height - verticalEdge * 2
  }
}

/** Where in a leaf's effective rect a point falls: its central box, or the nearest edge. */
export function resolveLeafDropZone(
  effectiveRect: PaneRect,
  point: { x: number; y: number }
): TabDropZone | null {
  if (effectiveRect.width <= 0 || effectiveRect.height <= 0) {
    return null
  }
  const x = (point.x - effectiveRect.left) / effectiveRect.width
  const y = (point.y - effectiveRect.top) / effectiveRect.height
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null
  }
  if (x >= 0.25 && x <= 0.75 && y >= 0.25 && y <= 0.75) {
    return 'center'
  }
  // Shares of the rect, not pixels: a wide pane must not favour its sides over its top and bottom.
  const edges = [
    { zone: 'left', distance: x },
    { zone: 'right', distance: 1 - x },
    { zone: 'up', distance: y },
    { zone: 'down', distance: 1 - y }
  ] as const
  return edges.reduce((nearest, edge) => (edge.distance < nearest.distance ? edge : nearest)).zone
}

export type PaneColumnSplitTarget = {
  groupId: string
  zone: Exclude<TabDropZone, 'center'>
}
