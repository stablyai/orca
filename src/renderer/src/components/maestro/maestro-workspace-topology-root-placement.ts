import type {
  MaestroCanvasInsets,
  MaestroCanvasSize,
  MaestroCanvasViewport
} from './maestro-canvas-viewport'
import { workspacePlacementProximity } from './maestro-workspace-placement-proximity'
import {
  findWorkspaceWindowPlacementNearPosition,
  placeWorkspaceWindowNearViewport,
  type MaestroWorkspaceWindowPlacement,
  type MaestroWorkspaceWindowPlacementAttempt
} from './maestro-workspace-window-layout'

export function placeMaestroWorkspaceTopologyRoot(
  placement: MaestroWorkspaceWindowPlacement,
  occupied: readonly MaestroWorkspaceWindowPlacement[],
  preferredPosition: { x: number; y: number },
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  insets: MaestroCanvasInsets
): MaestroWorkspaceWindowPlacementAttempt {
  const nearViewport = placeWorkspaceWindowNearViewport(
    placement,
    occupied,
    viewport,
    canvas,
    insets
  )
  const usableWorldSpan = Math.max(
    (canvas.width - insets.left - insets.right) / viewport.zoom,
    (canvas.height - insets.top - insets.bottom) / viewport.zoom
  )
  const { radius } = workspacePlacementProximity(placement)
  if (
    Math.hypot(
      nearViewport.position.x - preferredPosition.x,
      nearViewport.position.y - preferredPosition.y
    ) <= Math.min(usableWorldSpan, radius)
  ) {
    return { placement: nearViewport, collisionFree: true }
  }
  return findWorkspaceWindowPlacementNearPosition(placement, occupied, preferredPosition, {
    origin: preferredPosition,
    radius
  })
}
