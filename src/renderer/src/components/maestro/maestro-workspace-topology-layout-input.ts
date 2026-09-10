import type { WorkspaceCanvasDocument } from '../../../../shared/maestro-document-contract'
import type { WorkspaceSurfaceSnapshot } from '../../../../shared/maestro-workspace-canvas'
import type { CanvasAgentTopology } from './maestro-agent-topology'
import type { MaestroWorkspaceTopologyLayoutNode } from './maestro-workspace-topology-layout'
import { workspaceWindowPlacement } from './maestro-workspace-window-layout'

function exactResourceOwners(snapshot: WorkspaceSurfaceSnapshot): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const link of snapshot.automatic_links) {
    if (!['controls', 'executes', 'produces', 'resource-binding'].includes(link.link_type)) {
      continue
    }
    const source = snapshot.surfaces[link.source_surface_key]
    const target = snapshot.surfaces[link.target_surface_key]
    const terminalKey =
      source?.binding.kind === 'terminal'
        ? link.source_surface_key
        : target?.binding.kind === 'terminal'
          ? link.target_surface_key
          : undefined
    const resourceKey =
      source && source.binding.kind !== 'terminal'
        ? link.source_surface_key
        : target && target.binding.kind !== 'terminal'
          ? link.target_surface_key
          : undefined
    if (!terminalKey || !resourceKey) {
      continue
    }
    const owners = candidates.get(resourceKey) ?? new Set<string>()
    owners.add(terminalKey)
    candidates.set(resourceKey, owners)
  }
  return new Map(
    [...candidates].flatMap(([surfaceKey, owners]) =>
      owners.size === 1 ? [[surfaceKey, [...owners][0]!] as const] : []
    )
  )
}

export function buildMaestroWorkspaceTopologyLayoutNodes({
  snapshot,
  document,
  surfaceKeys,
  topology
}: {
  snapshot: WorkspaceSurfaceSnapshot
  document: WorkspaceCanvasDocument
  surfaceKeys: readonly string[]
  topology: CanvasAgentTopology
}): MaestroWorkspaceTopologyLayoutNode[] {
  const topologyBySurfaceKey = new Map(topology.nodes.map((node) => [node.surfaceId, node]))
  const owners = exactResourceOwners(snapshot)
  return surfaceKeys.flatMap((surfaceKey, index) => {
    const surface = snapshot.surfaces[surfaceKey]
    if (!surface) {
      return []
    }
    const agentNode = topologyBySurfaceKey.get(surfaceKey)
    return [
      {
        surfaceKey,
        preferredPlacement: workspaceWindowPlacement(surfaceKey, index, document, surface),
        parentSurfaceKey: agentNode?.parentSurfaceId,
        ownerSurfaceKey: owners.get(surfaceKey),
        functionLabel: agentNode?.functionLabel,
        taskIdentity: agentNode?.paneKey,
        isCoordinator: topology.coordinatorSurfaceId === surfaceKey
      }
    ]
  })
}
