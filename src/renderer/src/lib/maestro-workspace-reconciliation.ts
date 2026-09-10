import type {
  RuntimeMaestroWorkspaceCanvasMutationResult,
  RuntimeMaestroWorkspaceCanvasQueryResult
} from '../../../shared/runtime-types'

export type MaestroWorkspaceCanvasState = {
  status: 'loading' | 'ready' | 'unavailable'
  result: Extract<RuntimeMaestroWorkspaceCanvasQueryResult, { status: 'available' }> | null
  unavailableReason: string | null
  mutation: RuntimeMaestroWorkspaceCanvasMutationResult | null
}

export const INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE: MaestroWorkspaceCanvasState = {
  status: 'loading',
  result: null,
  unavailableReason: null,
  mutation: null
}

export function reconcileMaestroWorkspaceCanvasQuery(
  current: MaestroWorkspaceCanvasState,
  incoming: RuntimeMaestroWorkspaceCanvasQueryResult
): MaestroWorkspaceCanvasState {
  if (incoming.status === 'unavailable') {
    const lastKnown = incoming.last_known_snapshot
    return {
      ...current,
      status: 'unavailable',
      result:
        lastKnown &&
        current.result &&
        lastKnown.authority_revision >= current.result.snapshot.authority_revision
          ? {
              status: 'available',
              actor_id: current.result.actor_id,
              snapshot: lastKnown,
              canvas: current.result.canvas
            }
          : current.result,
      unavailableReason: incoming.reason
    }
  }
  if (
    current.result &&
    incoming.snapshot.authority_revision < current.result.snapshot.authority_revision
  ) {
    return current
  }
  const nextStatus = incoming.snapshot.state === 'unavailable' ? 'unavailable' : 'ready'
  if (
    current.result &&
    current.status === nextStatus &&
    current.result.actor_id === incoming.actor_id &&
    current.result.snapshot.authority_revision === incoming.snapshot.authority_revision &&
    current.result.canvas.revision === incoming.canvas.revision &&
    current.unavailableReason === incoming.snapshot.capability.reason
  ) {
    return current
  }
  return {
    status: nextStatus,
    result: incoming,
    unavailableReason: incoming.snapshot.capability.reason,
    mutation: current.mutation
  }
}

export function reconcileMaestroWorkspaceCanvasMutation(
  current: MaestroWorkspaceCanvasState,
  mutation: RuntimeMaestroWorkspaceCanvasMutationResult
): MaestroWorkspaceCanvasState {
  return { ...current, mutation }
}
