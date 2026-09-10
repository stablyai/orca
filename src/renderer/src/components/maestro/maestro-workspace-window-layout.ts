import type { WorkspaceCanvasDocument } from '../../../../shared/maestro-document-contract'
import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import type {
  MaestroCanvasInsets,
  MaestroCanvasSize,
  MaestroCanvasViewport
} from './maestro-canvas-viewport'

export type MaestroWorkspaceWindowPlacement = WorkspaceCanvasDocument['placements'][string]

export function addedMaestroSurfaceKeys(
  previous: readonly string[],
  current: readonly string[]
): string[] {
  const known = new Set(previous)
  return current.filter((surfaceKey) => !known.has(surfaceKey))
}

export function createMaestroSurfaceAdditionTracker() {
  const observedByScope = new Map<string, readonly string[]>()
  return {
    takeAdditions(scope: string, current: readonly string[], viewportReady = true): string[] {
      const previous = observedByScope.get(scope)
      if (previous && !viewportReady) {
        return []
      }
      observedByScope.delete(scope)
      observedByScope.set(scope, current)
      if (observedByScope.size > 64) {
        observedByScope.delete(observedByScope.keys().next().value!)
      }
      return previous && viewportReady ? addedMaestroSurfaceKeys(previous, current) : []
    }
  }
}

export function workspaceWindowPlacement(
  surfaceKey: string,
  index: number,
  document: WorkspaceCanvasDocument,
  surface?: WorkspaceSurface
): MaestroWorkspaceWindowPlacement {
  const isAnnotation = surface?.binding.kind === 'content' && surface.binding.annotation != null
  const size =
    surface?.content_type === 'terminal'
      ? { width: 760, height: 530 }
      : surface?.content_type === 'browser'
        ? { width: 680, height: 480 }
        : isAnnotation
          ? { width: 440, height: 360 }
          : { width: 360, height: 260 }
  return (
    document.placements[surfaceKey] ?? {
      position: { x: 36 + (index % 3) * 800, y: 52 + Math.floor(index / 3) * 570 },
      size,
      collapsed: false,
      z_order: index
    }
  )
}

export function workspaceWindowBounds(placement: MaestroWorkspaceWindowPlacement) {
  return {
    x: placement.position.x,
    y: placement.position.y,
    width: placement.size.width,
    height: placement.size.height
  }
}

const NEW_WINDOW_GAP = 40
const CURSOR_WINDOW_GAP_PX = 16
const MAX_PLACEMENT_ROWS = 64
const MAX_PLACEMENT_SCAN_RINGS = 16
const MAX_LAYOUT_COORDINATE = 1_000_000
const MAX_LAYOUT_Z_ORDER = 1_000_000

export type MaestroWorkspaceWindowPlacementAttempt = {
  placement: MaestroWorkspaceWindowPlacement
  collisionFree: boolean
}

export function workspaceWindowPlacementsOverlap(
  left: MaestroWorkspaceWindowPlacement,
  right: MaestroWorkspaceWindowPlacement
): boolean {
  return !(
    left.position.x + left.size.width + NEW_WINDOW_GAP <= right.position.x ||
    right.position.x + right.size.width + NEW_WINDOW_GAP <= left.position.x ||
    left.position.y + left.size.height + NEW_WINDOW_GAP <= right.position.y ||
    right.position.y + right.size.height + NEW_WINDOW_GAP <= left.position.y
  )
}

function boundedLayoutCoordinate(value: number): number {
  return Math.max(-MAX_LAYOUT_COORDINATE, Math.min(MAX_LAYOUT_COORDINATE, Math.round(value)))
}

function placementZOrder(
  placement: MaestroWorkspaceWindowPlacement,
  occupied: readonly MaestroWorkspaceWindowPlacement[]
): number {
  return Math.min(
    MAX_LAYOUT_Z_ORDER,
    Math.max(placement.z_order, ...occupied.map((item) => item.z_order + 1), 0)
  )
}

function* placementScanOffsets(): Generator<{ x: number; y: number }> {
  yield { x: 0, y: 0 }
  for (let ring = 1; ring <= MAX_PLACEMENT_SCAN_RINGS; ring += 1) {
    for (let x = -ring; x <= ring; x += 1) {
      yield { x, y: -ring }
    }
    for (let y = -ring + 1; y <= ring; y += 1) {
      yield { x: ring, y }
    }
    for (let x = ring - 1; x >= -ring; x -= 1) {
      yield { x, y: ring }
    }
    for (let y = ring - 1; y > -ring; y -= 1) {
      yield { x: -ring, y }
    }
  }
}

export function findWorkspaceWindowPlacementNearPosition(
  placement: MaestroWorkspaceWindowPlacement,
  occupied: readonly MaestroWorkspaceWindowPlacement[],
  preferredPosition: { x: number; y: number },
  proximity?: { origin: { x: number; y: number }; radius: number }
): MaestroWorkspaceWindowPlacementAttempt {
  if (proximity) {
    const dx = preferredPosition.x - proximity.origin.x
    const dy = preferredPosition.y - proximity.origin.y
    const distance = Math.hypot(dx, dy)
    if (distance > proximity.radius) {
      preferredPosition = {
        x: proximity.origin.x + (dx / distance) * proximity.radius,
        y: proximity.origin.y + (dy / distance) * proximity.radius
      }
    }
  }
  const zOrder = placementZOrder(placement, occupied)
  const stepX = placement.size.width + NEW_WINDOW_GAP
  const stepY = placement.size.height + NEW_WINDOW_GAP

  for (const offset of placementScanOffsets()) {
    const candidate = {
      ...placement,
      position: {
        x: boundedLayoutCoordinate(preferredPosition.x + offset.x * stepX),
        y: boundedLayoutCoordinate(preferredPosition.y + offset.y * stepY)
      },
      z_order: zOrder
    }
    if (
      proximity &&
      Math.hypot(
        candidate.position.x - proximity.origin.x,
        candidate.position.y - proximity.origin.y
      ) >
        proximity.radius + 1
    ) {
      continue
    }
    if (!occupied.some((item) => workspaceWindowPlacementsOverlap(candidate, item))) {
      return { placement: candidate, collisionFree: true }
    }
  }

  return {
    placement: {
      ...placement,
      position: {
        x: boundedLayoutCoordinate(preferredPosition.x),
        y: boundedLayoutCoordinate(preferredPosition.y)
      },
      z_order: zOrder
    },
    collisionFree: false
  }
}

function fitPlacementAxis(
  preferred: number,
  length: number,
  visibleStart: number,
  visibleEnd: number
): number {
  const available = visibleEnd - visibleStart
  if (length >= available) {
    return visibleStart + (available - length) / 2
  }
  return Math.max(visibleStart, Math.min(visibleEnd - length, preferred))
}

export function placeWorkspaceWindowAtCanvasPoint(
  placement: MaestroWorkspaceWindowPlacement,
  point: { x: number; y: number },
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  insets: MaestroCanvasInsets
): MaestroWorkspaceWindowPlacement {
  const visibleLeft = viewport.center.x + (insets.left - canvas.width / 2) / viewport.zoom
  const visibleRight =
    viewport.center.x + (canvas.width - insets.right - canvas.width / 2) / viewport.zoom
  const visibleTop = viewport.center.y + (insets.top - canvas.height / 2) / viewport.zoom
  const visibleBottom =
    viewport.center.y + (canvas.height - insets.bottom - canvas.height / 2) / viewport.zoom
  const gap = CURSOR_WINDOW_GAP_PX / viewport.zoom
  const above = point.y - placement.size.height - gap
  const below = point.y + gap
  const preferredY = above >= visibleTop ? above : below

  return {
    ...placement,
    position: {
      x: boundedLayoutCoordinate(
        fitPlacementAxis(
          point.x - placement.size.width / 2,
          placement.size.width,
          visibleLeft,
          visibleRight
        )
      ),
      y: boundedLayoutCoordinate(
        fitPlacementAxis(preferredY, placement.size.height, visibleTop, visibleBottom)
      )
    }
  }
}

function placementRowOffset(row: number): number {
  if (row === 0) {
    return 0
  }
  const distance = Math.ceil(row / 2)
  return row % 2 === 1 ? distance : -distance
}

export function placeWorkspaceWindowNearViewport(
  placement: MaestroWorkspaceWindowPlacement,
  occupied: readonly MaestroWorkspaceWindowPlacement[],
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  insets: MaestroCanvasInsets
): MaestroWorkspaceWindowPlacement {
  const usableScreenCenter = {
    x: (insets.left + canvas.width - insets.right) / 2,
    y: (insets.top + canvas.height - insets.bottom) / 2
  }
  const anchor = {
    x: viewport.center.x + (usableScreenCenter.x - canvas.width / 2) / viewport.zoom,
    y: viewport.center.y + (usableScreenCenter.y - canvas.height / 2) / viewport.zoom
  }
  const usableWorldWidth = (canvas.width - insets.left - insets.right) / viewport.zoom
  const columnX =
    usableWorldWidth >= placement.size.width * 2 + NEW_WINDOW_GAP
      ? [anchor.x - NEW_WINDOW_GAP / 2 - placement.size.width, anchor.x + NEW_WINDOW_GAP / 2]
      : [anchor.x - placement.size.width / 2]
  const originY = anchor.y - placement.size.height / 2
  const zOrder = placementZOrder(placement, occupied)

  for (let row = 0; row < MAX_PLACEMENT_ROWS; row += 1) {
    const y = originY + placementRowOffset(row) * (placement.size.height + NEW_WINDOW_GAP)
    for (const x of columnX) {
      const candidate = {
        ...placement,
        position: {
          x: boundedLayoutCoordinate(x),
          y: boundedLayoutCoordinate(y)
        },
        z_order: zOrder
      }
      if (!occupied.some((item) => workspaceWindowPlacementsOverlap(candidate, item))) {
        return candidate
      }
    }
  }

  return {
    ...placement,
    position: {
      x: boundedLayoutCoordinate(columnX[0]),
      y: boundedLayoutCoordinate(originY)
    },
    z_order: zOrder
  }
}

export function moveWorkspaceWindow(
  placement: MaestroWorkspaceWindowPlacement,
  delta: { x: number; y: number }
): MaestroWorkspaceWindowPlacement {
  return {
    ...placement,
    position: {
      x: placement.position.x + delta.x,
      y: placement.position.y + delta.y
    }
  }
}

export function resizeWorkspaceWindow(
  placement: MaestroWorkspaceWindowPlacement,
  delta: { x: number; y: number }
): MaestroWorkspaceWindowPlacement {
  return {
    ...placement,
    size: {
      width: Math.max(240, placement.size.width + delta.x),
      height: Math.max(150, placement.size.height + delta.y)
    }
  }
}
