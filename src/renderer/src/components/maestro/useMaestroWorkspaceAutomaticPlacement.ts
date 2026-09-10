import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import type { RuntimeMaestroWorkspaceCanvasScope } from '../../../../shared/runtime-types'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import type { MaestroWorkspaceTopologyLayoutNode } from './maestro-workspace-topology-layout'
import { layoutIncrementalMaestroWorkspaceTopology } from './maestro-workspace-topology-layout'
import {
  createMaestroSurfaceAdditionTracker,
  type MaestroWorkspaceWindowPlacement
} from './maestro-workspace-window-layout'
import type { useMaestroWorkspaceViewport } from './useMaestroWorkspaceViewport'
import { maestroWorkspaceMutationKey } from './maestro-workspace-mutation-key'

const surfaceAdditionTracker = createMaestroSurfaceAdditionTracker()
export const MAESTRO_REVEAL_INSETS = { top: 64, right: 16, bottom: 16, left: 16 } as const
export const MAESTRO_INSPECTOR_REVEAL_INSETS = {
  top: 64,
  right: 344,
  bottom: 16,
  left: 16
} as const

type PlacementMap = Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
type CanvasResult = NonNullable<MaestroWorkspaceCanvasResource['result']>

export function maestroAutomaticPlacementCandidateKeys(params: {
  additions: readonly string[]
  unplaced: readonly string[]
  topologyManaged: readonly string[]
  locallyCreatedSurfaceKey?: string
}): string[] {
  const unplaced = new Set(params.unplaced)
  return [
    ...new Set([
      ...params.additions.filter(
        (surfaceKey) => surfaceKey !== params.locallyCreatedSurfaceKey || unplaced.has(surfaceKey)
      ),
      ...params.unplaced,
      ...params.topologyManaged
    ])
  ]
}

export function useMaestroWorkspaceAutomaticPlacement({
  result,
  resource,
  scope,
  surfaceKeys,
  nodes,
  placements,
  setPlacements,
  optimisticPlacements,
  automaticallyPlacedSurfaceKeys,
  board
}: {
  result: CanvasResult | null
  resource: MaestroWorkspaceCanvasResource
  scope: RuntimeMaestroWorkspaceCanvasScope
  surfaceKeys: readonly string[]
  nodes: readonly MaestroWorkspaceTopologyLayoutNode[]
  placements: PlacementMap
  setPlacements: Dispatch<SetStateAction<PlacementMap>>
  optimisticPlacements: MutableRefObject<Record<string, MaestroWorkspaceWindowPlacement>>
  automaticallyPlacedSurfaceKeys: MutableRefObject<Set<string>>
  board: ReturnType<typeof useMaestroWorkspaceViewport>
}): void {
  const { viewportReady, viewport, size } = board
  const topologySignatureByScope = useRef(new Map<string, string>())
  useEffect(() => {
    if (!result) {
      return
    }
    const scopeKey = `${scope.execution_host_id}:${scope.workspace_key}`
    const additions = surfaceAdditionTracker.takeAdditions(scopeKey, surfaceKeys, viewportReady)
    for (const surfaceKey of automaticallyPlacedSurfaceKeys.current) {
      if (!result.snapshot.surfaces[surfaceKey]) {
        automaticallyPlacedSurfaceKeys.current.delete(surfaceKey)
      }
    }
    const topologyNodes = nodes.filter(
      (node) => node.isCoordinator || node.parentSurfaceKey || node.ownerSurfaceKey
    )
    const topologySignature = JSON.stringify(
      [...topologyNodes]
        .sort((left, right) => left.surfaceKey.localeCompare(right.surfaceKey))
        .map((node) => [
          node.surfaceKey,
          node.parentSurfaceKey,
          node.ownerSurfaceKey,
          node.functionLabel,
          node.taskIdentity,
          node.isCoordinator
        ])
    )
    const topologyChanged = topologySignatureByScope.current.get(scopeKey) !== topologySignature
    topologySignatureByScope.current.set(scopeKey, topologySignature)
    const unplaced = surfaceKeys.filter(
      (surfaceKey) =>
        !result.canvas.document.placements[surfaceKey] && !optimisticPlacements.current[surfaceKey]
    )
    const topologyManaged = topologyChanged
      ? topologyNodes
          .map((node) => node.surfaceKey)
          .filter((surfaceKey) => automaticallyPlacedSurfaceKeys.current.has(surfaceKey))
      : []
    const locallyCreatedSurfaceKey = resource.mutation?.surface_id
      ? workspaceSurfaceKey(resource.mutation.surface_id)
      : undefined
    const candidateKeys = maestroAutomaticPlacementCandidateKeys({
      additions,
      unplaced,
      topologyManaged,
      locallyCreatedSurfaceKey
    })
    if (candidateKeys.length === 0) {
      return
    }
    const candidates = new Set(candidateKeys)
    const existingPlacements = Object.fromEntries(
      Object.entries(placements).filter(([surfaceKey]) => !candidates.has(surfaceKey))
    )
    const layout = layoutIncrementalMaestroWorkspaceTopology({
      nodes,
      existingPlacements,
      viewport,
      canvas: size,
      insets: MAESTRO_REVEAL_INSETS
    })
    const positioned = Object.fromEntries(
      layout.automaticallyPlacedSurfaceKeys.flatMap((surfaceKey) => {
        const placement = layout.placements[surfaceKey]
        return placement ? [[surfaceKey, placement]] : []
      })
    )
    if (Object.keys(positioned).length === 0) {
      return
    }
    for (const [surfaceKey, placement] of Object.entries(positioned)) {
      const surface = result.snapshot.surfaces[surfaceKey]
      if (!surface) {
        continue
      }
      optimisticPlacements.current[surfaceKey] = placement
      automaticallyPlacedSurfaceKeys.current.add(surfaceKey)
      void resource.mutate({
        action: 'set-placement',
        surface_id: surface.id,
        placement,
        idempotency_key: maestroWorkspaceMutationKey('initial-placement', surfaceKey)
      })
    }
    setPlacements((current) => ({ ...current, ...positioned }))
  }, [
    nodes,
    automaticallyPlacedSurfaceKeys,
    optimisticPlacements,
    placements,
    resource,
    result,
    scope.execution_host_id,
    scope.workspace_key,
    setPlacements,
    size,
    surfaceKeys,
    viewport,
    viewportReady
  ])
}
