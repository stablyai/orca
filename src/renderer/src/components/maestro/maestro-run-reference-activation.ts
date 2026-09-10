import type { WorkspaceSurfaceSnapshot } from '../../../../shared/maestro-workspace-canvas'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import type { CanvasAgentTopology } from './maestro-agent-topology'
import { maestroWorkspaceMutationKey } from './maestro-workspace-mutation-key'
import {
  workspaceWindowBounds,
  type MaestroWorkspaceWindowPlacement
} from './maestro-workspace-window-layout'
import { MAESTRO_REVEAL_INSETS } from './useMaestroWorkspaceAutomaticPlacement'

export function activateMaestroRunReference(args: {
  reference: string
  topology: CanvasAgentTopology
  placements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
  snapshot: WorkspaceSurfaceSnapshot | undefined
  reveal: (
    bounds: ReturnType<typeof workspaceWindowBounds>,
    insets: typeof MAESTRO_REVEAL_INSETS
  ) => void
  selectSurface: (surfaceKey: string | null) => void
  mutate: MaestroWorkspaceCanvasResource['mutate']
}): boolean {
  const exactSurface = args.snapshot?.surfaces[args.reference]
  const exactPlacement = exactSurface ? args.placements[args.reference] : undefined
  if (exactSurface && exactPlacement) {
    args.reveal(workspaceWindowBounds(exactPlacement), MAESTRO_REVEAL_INSETS)
    args.selectSurface(args.reference)
    void args.mutate({
      action: 'focus',
      surface_id: exactSurface.id,
      idempotency_key: maestroWorkspaceMutationKey('focus', exactSurface.id.unified_tab_id)
    })
    return true
  }
  const candidates = args.topology.nodes.filter((node) => node.taskId === args.reference)
  const surfaceKey = candidates.length === 1 ? candidates[0]!.surfaceId : null
  const placement = surfaceKey ? args.placements[surfaceKey] : undefined
  const surface = surfaceKey ? args.snapshot?.surfaces[surfaceKey] : undefined
  if (!surfaceKey || !placement || !surface) {
    return false
  }
  args.reveal(workspaceWindowBounds(placement), MAESTRO_REVEAL_INSETS)
  args.selectSurface(surfaceKey)
  void args.mutate({
    action: 'focus',
    surface_id: surface.id,
    idempotency_key: maestroWorkspaceMutationKey('focus', surface.id.unified_tab_id)
  })
  return true
}

export function useMaestroRunReferenceActivation(
  args: Omit<Parameters<typeof activateMaestroRunReference>[0], 'reference'>
): (reference: string) => boolean {
  const { topology, placements, snapshot, reveal, selectSurface, mutate } = args
  return useCallback(
    (reference: string) =>
      activateMaestroRunReference({
        reference,
        topology,
        placements,
        snapshot,
        reveal,
        selectSurface,
        mutate
      }),
    [mutate, placements, reveal, selectSurface, snapshot, topology]
  )
}
import { useCallback } from 'react'
