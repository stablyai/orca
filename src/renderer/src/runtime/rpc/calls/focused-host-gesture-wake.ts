import { useAppStore } from '@/store'
import { getActiveWorkspaceOwnerTarget } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { provideFocusedHostEnvironmentId } from './runtime-rpc-background-read'

/** Lets a gesture's wake find the focused workspace's host without rpc calls importing the store. */
export function installFocusedHostGestureWake(): void {
  provideFocusedHostEnvironmentId(() => {
    const owner = getActiveWorkspaceOwnerTarget(useAppStore.getState())
    return owner?.kind === 'environment' ? owner.environmentId : null
  })
}
