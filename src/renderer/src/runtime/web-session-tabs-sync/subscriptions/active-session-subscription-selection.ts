import { useAppStore } from '../../../store/index'
import { mirroredRuntimeEnvironmentIdForWorkspace } from '../workspace-selection/mirrored-workspace-owner'

// Warm streams outlive selection; seed only the selected worktree on this host because IDs can collide across hosts.
export function isActiveSessionSubscriptionSelected(
  environmentId: string,
  worktreeId: string
): boolean {
  const state = useAppStore.getState()
  return (
    state.activeWorktreeId === worktreeId &&
    mirroredRuntimeEnvironmentIdForWorkspace(state, worktreeId) === environmentId
  )
}
