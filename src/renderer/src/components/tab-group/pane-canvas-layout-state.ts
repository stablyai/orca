import type { TabGroupLayoutNode } from '../../../../shared/tab-types'

export type PaneCanvasBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PaneCanvasWorkspaceState = {
  mode: 'split' | 'canvas'
  boundsByTerminalTabId: Record<string, PaneCanvasBounds>
}

export type PaneCanvasReconcileOptions = {
  preserveMissingBounds?: boolean
  maxPreservedBounds?: number
}

export const PANE_CANVAS_GAP = 8
export const PANE_CANVAS_MIN_WIDTH = 320
export const PANE_CANVAS_MIN_HEIGHT = 220
export const PANE_CANVAS_DEFAULT_WIDTH = 560
export const PANE_CANVAS_DEFAULT_HEIGHT = 360
const DEFAULT_MAX_PRESERVED_BOUNDS = 500

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeBounds(value: unknown, fallback: PaneCanvasBounds): PaneCanvasBounds {
  const candidate = value && typeof value === 'object' ? (value as Partial<PaneCanvasBounds>) : {}
  return {
    x: Math.max(0, finiteNumber(candidate.x, fallback.x)),
    y: Math.max(0, finiteNumber(candidate.y, fallback.y)),
    width: Math.max(PANE_CANVAS_MIN_WIDTH, finiteNumber(candidate.width, fallback.width)),
    height: Math.max(PANE_CANVAS_MIN_HEIGHT, finiteNumber(candidate.height, fallback.height))
  }
}

export function collectPaneCanvasGroupIds(layout: TabGroupLayoutNode): string[] {
  if (layout.type === 'leaf') {
    return [layout.groupId]
  }
  return [...collectPaneCanvasGroupIds(layout.first), ...collectPaneCanvasGroupIds(layout.second)]
}

export function arrangePaneCanvasBounds(
  terminalTabIds: readonly string[],
  viewportWidth = 1280,
  currentBounds: Readonly<Record<string, PaneCanvasBounds>> = {}
): Record<string, PaneCanvasBounds> {
  const rightEdge = Math.max(PANE_CANVAS_DEFAULT_WIDTH, viewportWidth - PANE_CANVAS_GAP)
  const arranged: Record<string, PaneCanvasBounds> = {}
  let x = PANE_CANVAS_GAP
  let y = PANE_CANVAS_GAP
  let rowHeight = 0
  for (const terminalTabId of terminalTabIds) {
    const current = currentBounds[terminalTabId]
    const width = current?.width ?? PANE_CANVAS_DEFAULT_WIDTH
    const height = current?.height ?? PANE_CANVAS_DEFAULT_HEIGHT
    if (x > PANE_CANVAS_GAP && x + width > rightEdge) {
      x = PANE_CANVAS_GAP
      y += rowHeight + PANE_CANVAS_GAP
      rowHeight = 0
    }
    arranged[terminalTabId] = { x, y, width, height }
    x += width + PANE_CANVAS_GAP
    rowHeight = Math.max(rowHeight, height)
  }
  return arranged
}

/** Repair already-overlapping panes without otherwise rearranging the Canvas. */
export function resolvePaneCanvasOverlaps(
  terminalTabIds: readonly string[],
  currentBounds: Readonly<Record<string, PaneCanvasBounds>>
): Record<string, PaneCanvasBounds> {
  const resolved: Record<string, PaneCanvasBounds> = {}
  const placed: PaneCanvasBounds[] = []
  for (const terminalTabId of terminalTabIds) {
    const bounds = currentBounds[terminalTabId]
    if (!bounds) {
      continue
    }
    const next = resolvePaneCanvasDrop(bounds, placed)
    resolved[terminalTabId] = next
    placed.push(next)
  }
  return resolved
}

export function createPaneCanvasWorkspaceState(
  terminalTabIds: readonly string[],
  viewportWidth?: number
): PaneCanvasWorkspaceState {
  return {
    mode: 'split',
    boundsByTerminalTabId: arrangePaneCanvasBounds(terminalTabIds, viewportWidth)
  }
}

export function reconcilePaneCanvasWorkspaceState(
  state: PaneCanvasWorkspaceState,
  terminalTabIds: readonly string[],
  viewportWidth?: number,
  options: PaneCanvasReconcileOptions = {}
): PaneCanvasWorkspaceState {
  const arranged = arrangePaneCanvasBounds(terminalTabIds, viewportWidth)
  const boundsByTerminalTabId: Record<string, PaneCanvasBounds> = {}
  for (const terminalTabId of terminalTabIds) {
    const retained = state.boundsByTerminalTabId[terminalTabId]
    if (retained) {
      boundsByTerminalTabId[terminalTabId] = normalizeBounds(retained, arranged[terminalTabId])
    }
  }
  for (const terminalTabId of terminalTabIds) {
    if (boundsByTerminalTabId[terminalTabId]) {
      continue
    }
    const arrangedBounds = arranged[terminalTabId]
    boundsByTerminalTabId[terminalTabId] = resolvePaneCanvasDrop(
      arrangedBounds,
      Object.values(boundsByTerminalTabId)
    )
  }
  const activeBounds = resolvePaneCanvasOverlaps(terminalTabIds, boundsByTerminalTabId)
  if (!options.preserveMissingBounds) {
    return {
      ...state,
      boundsByTerminalTabId: activeBounds
    }
  }

  const activeIds = new Set(terminalTabIds)
  const maximum = Math.max(
    terminalTabIds.length,
    options.maxPreservedBounds ?? DEFAULT_MAX_PRESERVED_BOUNDS
  )
  const dormantLimit = maximum - terminalTabIds.length
  const dormantCandidates = Object.entries(state.boundsByTerminalTabId).filter(
    ([terminalTabId]) => !activeIds.has(terminalTabId)
  )
  const dormantEntries = (dormantLimit > 0 ? dormantCandidates.slice(-dormantLimit) : []).map(
    ([terminalTabId, bounds]) => [
      terminalTabId,
      normalizeBounds(bounds, {
        x: PANE_CANVAS_GAP,
        y: PANE_CANVAS_GAP,
        width: PANE_CANVAS_DEFAULT_WIDTH,
        height: PANE_CANVAS_DEFAULT_HEIGHT
      })
    ]
  )

  return {
    ...state,
    // Why: global canvases render only live sessions, but a stopped session may
    // return with the same tab id. Keep a bounded dormant tail so that restart
    // restores its previous location without allowing localStorage to grow forever.
    boundsByTerminalTabId: { ...Object.fromEntries(dormantEntries), ...activeBounds }
  }
}

function boundsOverlap(
  candidate: PaneCanvasBounds,
  other: PaneCanvasBounds,
  gap = PANE_CANVAS_GAP
): boolean {
  return !(
    candidate.x + candidate.width + gap <= other.x ||
    other.x + other.width + gap <= candidate.x ||
    candidate.y + candidate.height + gap <= other.y ||
    other.y + other.height + gap <= candidate.y
  )
}

/** Finds the nearest clear position around the requested drop. */
export function resolvePaneCanvasDrop(
  requested: PaneCanvasBounds,
  otherBounds: readonly PaneCanvasBounds[]
): PaneCanvasBounds {
  const queue: PaneCanvasBounds[] = [requested]
  const seen = new Set<string>()
  const maxAttempts = Math.max(64, otherBounds.length * otherBounds.length * 4)
  let attempts = 0

  while (queue.length > 0 && attempts < maxAttempts) {
    queue.sort(
      (left, right) =>
        (left.x - requested.x) ** 2 +
        (left.y - requested.y) ** 2 -
        ((right.x - requested.x) ** 2 + (right.y - requested.y) ** 2)
    )
    const candidate = queue.shift()!
    const key = `${candidate.x}:${candidate.y}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    attempts += 1
    const collisions = otherBounds.filter((other) => boundsOverlap(candidate, other))
    if (collisions.length === 0) {
      return candidate
    }
    for (const collision of collisions) {
      const left = collision.x - candidate.width - PANE_CANVAS_GAP
      const above = collision.y - candidate.height - PANE_CANVAS_GAP
      if (left >= 0) {
        queue.push({ ...candidate, x: left })
      }
      if (above >= 0) {
        queue.push({ ...candidate, y: above })
      }
      queue.push(
        { ...candidate, x: collision.x + collision.width + PANE_CANVAS_GAP },
        { ...candidate, y: collision.y + collision.height + PANE_CANVAS_GAP }
      )
    }
  }

  const bottom = otherBounds.reduce(
    (maximum, bounds) => Math.max(maximum, bounds.y + bounds.height),
    requested.y
  )
  return { ...requested, y: bottom + PANE_CANVAS_GAP }
}
