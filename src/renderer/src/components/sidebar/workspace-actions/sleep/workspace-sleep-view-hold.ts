import { useAppStore } from '@/store'
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { markWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import {
  holdWorktreeSleepView,
  isWorktreeSleepViewHeld,
  releaseWorktreeSleepView,
  subscribeWorktreeSleepView
} from '@/lib/worktree-sleep-view'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'

/** Holds the selected workspace view-only until the user selects anything else. */
function holdSelectedSleepView(worktreeId: string): void {
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
}

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
  holdSelectedSleepView(worktreeId)
  return true
}

/**
 * At startup, right after the session restores the selection and before any pane mounts: an Orca
 * Cloud workspace that was asleep when Orca quit comes back selected and still asleep. Its panes
 * wait for Wake instead of reattaching (which would wake the sandbox). Gated on the VM record main
 * keeps on disk, so it holds before any status read; a running record, or a wake already under
 * way, is left alone. Returns the workspace it held, if any.
 */
export function holdRestoredAsleepCloudSelection(
  runtimes: readonly EphemeralVmRuntimeRecord[]
): string | null {
  const worktreeId = useAppStore.getState().activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const record = runtimes.find((runtime) => runtime.workspaceId === worktreeId)
  if (record?.recipe?.provider !== 'orca-cloud' || record.status !== 'suspended') {
    return null
  }
  markWorktreeSleepIntent(worktreeId)
  if (!isWorktreeSleepViewHeld(worktreeId)) {
    holdSelectedSleepView(worktreeId)
  }
  return worktreeId
}
