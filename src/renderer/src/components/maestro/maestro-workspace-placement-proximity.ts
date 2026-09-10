import type { MaestroWorkspaceWindowPlacement } from './maestro-workspace-window-layout'

export function workspacePlacementProximity(
  placement: MaestroWorkspaceWindowPlacement,
  anchor: MaestroWorkspaceWindowPlacement = placement
): { origin: { x: number; y: number }; radius: number } {
  return {
    origin: anchor.position,
    radius:
      3 *
      Math.max(anchor.size.width, anchor.size.height, placement.size.width, placement.size.height)
  }
}
