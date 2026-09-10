import type { WorkspaceCanvasDocument } from '../../../../shared/maestro-document-contract'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import {
  workspaceWindowPlacement,
  type MaestroWorkspaceWindowPlacement
} from './maestro-workspace-window-layout'

export function initialMaestroWorkspacePlacements(
  document: WorkspaceCanvasDocument,
  snapshot: NonNullable<MaestroWorkspaceCanvasResource['result']>['snapshot'],
  surfaceKeys: readonly string[]
): Record<string, MaestroWorkspaceWindowPlacement> {
  return Object.fromEntries(
    surfaceKeys.map((surfaceKey, index) => [
      surfaceKey,
      workspaceWindowPlacement(surfaceKey, index, document, snapshot.surfaces[surfaceKey])
    ])
  )
}

export function sameMaestroWorkspacePlacementGeometry(
  left: MaestroWorkspaceWindowPlacement,
  right: MaestroWorkspaceWindowPlacement
): boolean {
  return (
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.size.width === right.size.width &&
    left.size.height === right.size.height &&
    left.collapsed === right.collapsed
  )
}
