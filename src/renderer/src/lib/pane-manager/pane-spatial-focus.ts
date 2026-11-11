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

// Default for callers without applied pane styles; production passes the current divider size.
const DEFAULT_DIVIDER_SIZE_PX = getDividerHitSize({})
// Travel-axis tolerance beyond the divider itself.
const SHARED_BORDER_SLACK_PX = 6
// Why: at non-zero UI zoom aligned panes land fractions of a pixel apart (a 10px divider measures 9.998779).
const SUBPIXEL_SLACK_PX = 0.5

export function isSpatialFocusDirection(
  direction: FocusPaneDirection
): direction is SpatialFocusDirection {
  return direction === 'left' || direction === 'right' || direction === 'up' || direction === 'down'
}

export function findAdjacentPaneId(
  sourceId: number,
  panes: readonly SpatialPaneRect[],
  direction: SpatialFocusDirection,
  dividerSize = DEFAULT_DIVIDER_SIZE_PX
): number | null {
  const source = panes.find((pane) => pane.id === sourceId)
  if (!source || !hasPositiveArea(source)) {
    return null
  }

  for (const candidate of panes) {
    if (candidate.id === sourceId || !hasPositiveArea(candidate)) {
      continue
    }
    if (isAdjacent(source, candidate, direction, dividerSize)) {
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
  dividerSize = DEFAULT_DIVIDER_SIZE_PX
): number | null {
  return findAdjacentPaneId(sourceId, collectPaneRectsInTreeOrder(panes), direction, dividerSize)
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

export type SpatialFocusOptions = {
  dividerSize?: number
  readLayout?: (find: () => number | null) => number | null
  beforeFocus?: () => void
}

// Query before committing layout or focus changes.
export function applySpatialPaneFocusKey(
  event: SpatialFocusKeyEvent,
  manager: SpatialFocusPaneManager,
  direction: SpatialFocusDirection,
  options: SpatialFocusOptions = {}
): boolean {
  const panes = manager.getPanes()
  const activeId = manager.getActivePane()?.id ?? panes[0]?.id
  if (activeId === undefined) {
    return false
  }
  const findNeighbor = () =>
    findSpatiallyAdjacentPaneId(activeId, panes, direction, options.dividerSize)
  const neighborId = options.readLayout ? options.readLayout(findNeighbor) : findNeighbor()
  if (neighborId === null) {
    return false
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  options.beforeFocus?.()
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
  dividerSize: number
): boolean {
  const maxSharedBorderGap = dividerSize + SHARED_BORDER_SLACK_PX
  const firstRight = first.x + first.width
  const firstBottom = first.y + first.height
  const secondRight = second.x + second.width
  const secondBottom = second.y + second.height

  // Why: dividers are in-flow, so the perpendicular span also owns the divider after it; else a source whose top-left sits in a misaligned divider band has no neighbor.
  if (direction === 'left') {
    return (
      edgesShare(first.x, secondRight, maxSharedBorderGap) &&
      first.y >= second.y - SUBPIXEL_SLACK_PX &&
      first.y < secondBottom + dividerSize - SUBPIXEL_SLACK_PX
    )
  }
  if (direction === 'right') {
    return (
      edgesShare(firstRight, second.x, maxSharedBorderGap) &&
      first.y >= second.y - SUBPIXEL_SLACK_PX &&
      first.y < secondBottom + dividerSize - SUBPIXEL_SLACK_PX
    )
  }
  if (direction === 'up') {
    return (
      edgesShare(first.y, secondBottom, maxSharedBorderGap) &&
      first.x >= second.x - SUBPIXEL_SLACK_PX &&
      first.x < secondRight + dividerSize - SUBPIXEL_SLACK_PX
    )
  }
  return (
    edgesShare(firstBottom, second.y, maxSharedBorderGap) &&
    first.x >= second.x - SUBPIXEL_SLACK_PX &&
    first.x < secondRight + dividerSize - SUBPIXEL_SLACK_PX
  )
}

function edgesShare(left: number, right: number, maxSharedBorderGap: number): boolean {
  return Math.abs(left - right) <= maxSharedBorderGap
}
