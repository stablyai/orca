import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../shared/worktree/host-qualified-identity'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'

type WorkspaceUnreadState = Pick<
  AppState,
  'workspaceUnreadRaisedByMarkers' | 'workspacesMarkedUnreadByUser'
>

/** Full removal retires every host identity; a twin removal retires only its named host. */
export function removeWorkspaceUnreadState(
  state: WorkspaceUnreadState,
  targets: readonly { id: string; hostId?: ExecutionHostId }[]
): WorkspaceUnreadState {
  const ids = new Set(targets.filter((target) => !target.hostId).map((target) => target.id))
  const keys = new Set<string>(
    targets.flatMap((target) =>
      target.hostId ? [composeWorktreeHostIdentity(target.hostId, target.id)] : []
    )
  )
  if (ids.size > 0) {
    for (const key of [
      ...Object.keys(state.workspaceUnreadRaisedByMarkers ?? {}),
      ...Object.keys(state.workspacesMarkedUnreadByUser ?? {})
    ]) {
      if (ids.has(getWorktreeIdFromHostIdentity(key))) {
        keys.add(key)
      }
    }
  }
  return {
    workspaceUnreadRaisedByMarkers: omitRecordKeys(state.workspaceUnreadRaisedByMarkers, keys),
    workspacesMarkedUnreadByUser: omitRecordKeys(state.workspacesMarkedUnreadByUser, keys)
  }
}
