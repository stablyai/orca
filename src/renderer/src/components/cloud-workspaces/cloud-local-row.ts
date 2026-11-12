// Does this window have the sidebar row for a cloud workspace this desktop's runtime record names?
// (REG-8b) A runtime record alone is not enough: after a sign-out and sign-in, or a lost project,
// main still knows the sandbox, but this window has no row. Then the sidebar's flows (delete, sleep,
// archive) refuse with "Workspace list changed" and activating the row does nothing, so Home acts
// through the control plane (or pairs, for Open) as it would on another desktop.
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'

export function hasLocalSidebarRow(local: {
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
}): local is { worktreeId: string; runtimeEnvironmentId?: string | null } {
  if (!local.worktreeId) {
    return false
  }
  const host = local.runtimeEnvironmentId
    ? toRuntimeExecutionHostId(local.runtimeEnvironmentId)
    : undefined
  const state = useAppStore.getState()
  // The runtime host's row, or the one row with that id (a record from before host-qualified rows).
  return Boolean(
    getWorktreeOnHostFromState(state, local.worktreeId, host) ??
    getWorktreeOnHostFromState(state, local.worktreeId, undefined)
  )
}

/** The sidebar row this desktop runs for `sandboxId`, or null when there is none to act on. */
export async function localWorktreeIdWithRow(sandboxId: string): Promise<string | null> {
  const local = (await window.api.cloudWorkspaces.localWorkspaces()).find(
    (entry) => entry.sandboxId === sandboxId && entry.worktreeId
  )
  return local && hasLocalSidebarRow(local) ? local.worktreeId : null
}
