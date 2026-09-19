import { getDividerHitSize } from './pane-divider'

export type SpatialFocusDirection = 'left' | 'right' | 'up' | 'down'

export type SequentialFocusDirection = 'next' | 'previous'

export type FocusPaneDirection = SequentialFocusDirection | SpatialFocusDirection

export type SpatialPaneRect = {
  id: number
  x: number
  y: number
  width: number
  height: number
}

export type SpatialPaneSource = {
  id: number
  container: HTMLElement
}

// Why: leaf rects come from getBoundingClientRect, so a divider sits between
// neighbors. Default hit-area is 10px; slack covers thicker custom dividers
// without jumping over a real pane.
export const PANE_ADJACENCY_MAX_GAP_PX = getDividerHitSize({}) + 6

export function isSpatialFocusDirection(
  direction: FocusPaneDirection
): direction is SpatialFocusDirection {
  return direction === 'left' || direction === 'right' || direction === 'up' || direction === 'down'
}

export function findAdjacentPaneId(
  sourceId: number,
  panes: readonly SpatialPaneRect[],
  direction: SpatialFocusDirection,
  maxSharedBorderGap = PANE_ADJACENCY_MAX_GAP_PX
): number | null {
  const source = panes.find((pane) => pane.id === sourceId)
  if (!source || !hasPositiveArea(source)) {
    return null
  }

  for (const candidate of panes) {
    if (candidate.id === sourceId || !hasPositiveArea(candidate)) {
      continue
    }
    if (isAdjacent(source, candidate, direction, maxSharedBorderGap)) {
      return candidate.id
    }
  }
  return null
}

export function collectPaneRectsInTreeOrder(
  panes: readonly SpatialPaneSource[]
): SpatialPaneRect[] {
  if (panes.length === 0) {
    return []
  }

  const byContainer = new Map<HTMLElement, SpatialPaneSource>()
  for (const pane of panes) {
    byContainer.set(pane.container, pane)
  }

  const leaves: HTMLElement[] = []
  collectPaneLeaves(findTopSplitOrPane(panes[0].container), leaves)

  const seen = new Set<number>()
  const ordered: SpatialPaneRect[] = []
  for (const leaf of leaves) {
    const pane = byContainer.get(leaf)
    if (!pane || seen.has(pane.id)) {
      continue
    }
    seen.add(pane.id)
    ordered.push(toRect(pane))
  }
  for (const pane of panes) {
    if (seen.has(pane.id)) {
      continue
    }
    seen.add(pane.id)
    ordered.push(toRect(pane))
  }
  return ordered
}

export function findSpatiallyAdjacentPaneId(
  sourceId: number,
  panes: readonly SpatialPaneSource[],
  direction: SpatialFocusDirection,
  maxSharedBorderGap = PANE_ADJACENCY_MAX_GAP_PX
): number | null {
  return findAdjacentPaneId(
    sourceId,
    collectPaneRectsInTreeOrder(panes),
    direction,
    maxSharedBorderGap
  )
}

export type SpatialFocusKeyEvent = {
  preventDefault(): void
  stopImmediatePropagation(): void
}

export type SpatialFocusPaneManager = {
  getPanes(): readonly SpatialPaneSource[]
  getActivePane(): { id: number } | null
  setActivePane(paneId: number, opts: { focus: boolean }): void
}

// Why: claim the chord only when a neighbor exists so Mod+Alt+ArrowLeft/Right
// can still reach worktree history at a layout edge.
export function applySpatialPaneFocusKey(
  event: SpatialFocusKeyEvent,
  manager: SpatialFocusPaneManager,
  direction: SpatialFocusDirection
): boolean {
  const panes = manager.getPanes()
  const activeId = manager.getActivePane()?.id ?? panes[0]?.id
  if (activeId === undefined) {
    return false
  }
  const neighborId = findSpatiallyAdjacentPaneId(activeId, panes, direction)
  if (neighborId === null) {
    return false
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  manager.setActivePane(neighborId, { focus: true })
  return true
}

function hasPositiveArea(pane: SpatialPaneRect): boolean {
  return pane.width > 0 && pane.height > 0
}

function toRect(pane: SpatialPaneSource): SpatialPaneRect {
  const rect = pane.container.getBoundingClientRect()
  return {
    id: pane.id,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  }
}

function findTopSplitOrPane(container: HTMLElement): HTMLElement {
  let current = container
  while (current.parentElement?.classList.contains('pane-split')) {
    current = current.parentElement
  }
  return current
}

function collectPaneLeaves(el: HTMLElement, out: HTMLElement[]): void {
  if (el.classList.contains('pane')) {
    out.push(el)
    return
  }
  if (!el.classList.contains('pane-split')) {
    return
  }
  for (const child of el.children) {
    if (
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
    ) {
      collectPaneLeaves(child, out)
    }
  }
}

// Windows Terminal Pane::_IsAdjacent: shared travel-axis border, then the
// source top-left must fall in the candidate's half-closed span on the
// perpendicular axis. First matching leaf in tree order is the neighbor.
function isAdjacent(
  first: SpatialPaneRect,
  second: SpatialPaneRect,
  direction: SpatialFocusDirection,
  maxSharedBorderGap: number
): boolean {
  const firstRight = first.x + first.width
  const firstBottom = first.y + first.height
  const secondRight = second.x + second.width
  const secondBottom = second.y + second.height

  if (direction === 'left') {
    return (
      edgesShare(first.x, secondRight, maxSharedBorderGap) &&
      first.y >= second.y &&
      first.y < secondBottom
    )
  }
  if (direction === 'right') {
    return (
      edgesShare(firstRight, second.x, maxSharedBorderGap) &&
      first.y >= second.y &&
      first.y < secondBottom
    )
  }
  if (direction === 'up') {
    return (
      edgesShare(first.y, secondBottom, maxSharedBorderGap) &&
      first.x >= second.x &&
      first.x < secondRight
    )
  }
  return (
    edgesShare(firstBottom, second.y, maxSharedBorderGap) &&
    first.x >= second.x &&
    first.x < secondRight
  )
}

function edgesShare(left: number, right: number, maxSharedBorderGap: number): boolean {
  return Math.abs(left - right) <= maxSharedBorderGap
}
