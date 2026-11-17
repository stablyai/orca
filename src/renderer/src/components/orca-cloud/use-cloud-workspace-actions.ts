// LIFECYCLE-MATRIX: the workspace's lifecycle column (dot state, a move in flight, a delete under
// way) and what it offers there; every cloud surface reads this one answer.
import { useAppStore } from '@/store'
import {
  cloudLifecycleState,
  cloudWorkspaceActions,
  type CloudLifecycleState,
  type CloudWorkspaceActions
} from '@/lib/orca-cloud/cloud-lifecycle-actions'
import { useCloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'

export function useCloudLifecycleState(worktreeId: string): CloudLifecycleState | null {
  const view = useCloudWorkspaceView(worktreeId, { pairedRows: true })
  const move = useCloudMoveState()
  const deleting = useAppStore((state) => state.deleteStateByWorktreeId[worktreeId]?.isDeleting)
  if (!view.isCloud) {
    return null
  }
  return cloudLifecycleState(view.state, {
    moving: move.stage === 'running' && move.workspaceId === worktreeId,
    deleting: deleting === true
  })
}

/** Null off Orca Cloud: the surface keeps its local behavior. */
export function useCloudWorkspaceActions(worktreeId: string): CloudWorkspaceActions | null {
  const state = useCloudLifecycleState(worktreeId)
  return state ? cloudWorkspaceActions(state) : null
}
