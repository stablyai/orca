import type { AuxWindowBounds } from '../../../shared/aux-window'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/**
 * Detached-pane fields for the persisted session.
 *
 * Omitted entirely when nothing is detached, so ordinary sessions carry neither
 * key and older builds keep hydrating them as "nothing detached".
 */
export function buildDetachedPaneSessionData(snapshot: {
  detachedGroupIds: string[]
  auxWindowBoundsByGroupId: Record<string, AuxWindowBounds>
}): Pick<WorkspaceSessionState, 'detachedGroupIds' | 'auxWindowBoundsByGroupId'> {
  return {
    detachedGroupIds: snapshot.detachedGroupIds.length > 0 ? snapshot.detachedGroupIds : undefined,
    auxWindowBoundsByGroupId:
      Object.keys(snapshot.auxWindowBoundsByGroupId).length > 0
        ? snapshot.auxWindowBoundsByGroupId
        : undefined
  }
}
