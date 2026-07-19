import type { WorkspacePaneOpenEdge } from '../../store/slices/workspace-split-view'

export type WorkspaceSplitDropRect = {
  left: number
  top: number
  width: number
  height: number
}

export type WorkspaceSplitDropZone = {
  targetWorktreeId: string
  edge: WorkspacePaneOpenEdge
  /** Viewport-coordinate rect for the drop highlight. */
  highlightRect: WorkspaceSplitDropRect
}

// Outer quarter of a pane = split on that edge; the middle = replace the
// pane's project. Mirrors resolveDropZone's edge semantics for tab drags.
const EDGE_ZONE_RATIO = 0.25

function rectContains(rect: WorkspaceSplitDropRect, x: number, y: number): boolean {
  return (
    x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
  )
}

function edgeHighlightRect(
  rect: WorkspaceSplitDropRect,
  edge: WorkspacePaneOpenEdge
): WorkspaceSplitDropRect {
  switch (edge) {
    case 'left':
      return { ...rect, width: rect.width / 2 }
    case 'right':
      return { ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 }
    case 'up':
      return { ...rect, height: rect.height / 2 }
    case 'down':
      return { ...rect, top: rect.top + rect.height / 2, height: rect.height / 2 }
    case 'replace':
      return rect
  }
}

/** Map a pointer over the visible pane rects to a drop zone, or null when the
 *  pointer is over none of them. Pure — DOM reading lives in the helper below. */
export function resolveSplitPaneDropZone(
  point: { x: number; y: number },
  panes: readonly { worktreeId: string; rect: WorkspaceSplitDropRect }[]
): WorkspaceSplitDropZone | null {
  const pane = panes.find(({ rect }) => rect.width > 0 && rectContains(rect, point.x, point.y))
  if (!pane) {
    return null
  }
  const relativeX = (point.x - pane.rect.left) / pane.rect.width
  const relativeY = (point.y - pane.rect.top) / pane.rect.height
  const edgeDistances: [WorkspacePaneOpenEdge, number][] = [
    ['left', relativeX],
    ['right', 1 - relativeX],
    ['up', relativeY],
    ['down', 1 - relativeY]
  ]
  edgeDistances.sort((a, b) => a[1] - b[1])
  const [nearestEdge, nearestDistance] = edgeDistances[0]
  const edge = nearestDistance <= EDGE_ZONE_RATIO ? nearestEdge : 'replace'
  return {
    targetWorktreeId: pane.worktreeId,
    edge,
    highlightRect: edgeHighlightRect(pane.rect, edge)
  }
}

/** Whether a viewport point lies inside the workspace body at all — used to
 *  bound the frame-tracked drop fallback so a release back over the sidebar
 *  can never commit a stale split zone. */
export function isPointInsideWorkspaceSplitDropRoot(x: number, y: number): boolean {
  const root = document.querySelector('[data-workspace-split-drop-root]')
  if (!(root instanceof HTMLElement)) {
    return false
  }
  const rect = root.getBoundingClientRect()
  return rect.width > 0 && rectContains(rect, x, y)
}

/** DOM wrapper: hit-test the workspace body and its visible pane surfaces.
 *  Hidden surfaces report zero-size rects and are skipped. */
export function getWorkspaceSplitDropTargetFromPoint(
  x: number,
  y: number
): WorkspaceSplitDropZone | null {
  const root = document.querySelector('[data-workspace-split-drop-root]')
  if (!(root instanceof HTMLElement)) {
    return null
  }
  const rootRect = root.getBoundingClientRect()
  if (rootRect.width === 0 || !rectContains(rootRect, x, y)) {
    return null
  }
  const panes: { worktreeId: string; rect: WorkspaceSplitDropRect }[] = []
  for (const element of root.querySelectorAll('[data-workspace-pane-id]')) {
    if (!(element instanceof HTMLElement)) {
      continue
    }
    const worktreeId = element.dataset.workspacePaneId
    if (!worktreeId) {
      continue
    }
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      continue
    }
    panes.push({
      worktreeId,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    })
  }
  return resolveSplitPaneDropZone({ x, y }, panes)
}
