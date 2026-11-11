import { useAppStore } from '@/store'
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  holdWorktreeSleepView,
  isWorktreeSleepViewHeld,
  releaseWorktreeSleepView,
  subscribeWorktreeSleepView
} from '@/lib/worktree-sleep-view'

/**
 * Sleeping the Orca Cloud workspace on screen keeps it selected, read-only, instead of leaving for
 * Home. The hold ends when the user selects anything else; it never changes the selection itself.
 * Returns whether the workspace is held (only the active cloud workspace can be).
 */
export function holdActiveCloudSleepView(worktreeId: string): boolean {
  if (isWorktreeSleepViewHeld(worktreeId)) {
    return true
  }
  if (
    useAppStore.getState().activeWorktreeId !== worktreeId ||
    !getCloudWorkspaceSnapshot().ids.has(worktreeId)
  ) {
    return false
  }
  holdWorktreeSleepView(worktreeId)
  let stopped = false
  const stop = (): void => {
    stopped = true
    offSelection()
    offHold()
  }
  const offSelection = useAppStore.subscribe((state) => {
    if (state.activeWorktreeId !== worktreeId) {
      stop()
      releaseWorktreeSleepView(worktreeId)
    }
  })
  const offHold = subscribeWorktreeSleepView(() => {
    if (!stopped && !isWorktreeSleepViewHeld(worktreeId)) {
      stop()
    }
  })
  return true
}
