import type { AppState } from '@/store/types'
import { workspaceOwnerHostId } from '@/lib/workspace/ownership/workspace-row-owner-host'
import {
  parseOrcaCloudHostScopeKey,
  selectOrcaCloudHostScopeKey
} from './use-sidebar-hidden-checkouts'

type LeaveState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'runtimeEnvironments'
  | 'setActiveWorktree'
> &
  Partial<Pick<AppState, 'orcaProfileAuthStatus' | 'cloudAccountIdByEnvironmentId'>>

function activeHostId(state: LeaveState): string | null {
  if (!state.activeWorktreeId) {
    return null
  }
  // The host-qualified selection first: a cloud project and its local twin share repo ids.
  return state.activeWorkspaceExecutionHostId ?? workspaceOwnerHostId(state, state.activeWorktreeId)
}

/**
 * The active workspace's host just left the active team's scope: it was the team's a moment ago
 * and now is not (a team or account switch). Only that edge counts, so a launch whose team or
 * runtimes are still loading never drops a restored cloud workspace.
 */
export function activeCloudWorkspaceLeftTeam(
  previousScopeKey: string,
  nextScopeKey: string,
  hostId: string | null
): boolean {
  if (!hostId || previousScopeKey === nextScopeKey) {
    return false
  }
  return (
    parseOrcaCloudHostScopeKey(previousScopeKey).primaryHostIds.has(hostId) &&
    parseOrcaCloudHostScopeKey(nextScopeKey).hiddenHostIds.has(hostId)
  )
}

/**
 * Why: a team switch hides the old team's sandboxes from every list, but the main pane kept
 * showing the one that was open. Move off it as a host removal does (no active workspace, the
 * empty landing). Its terminals stay: the sandbox is still the old team's to come back to.
 */
export function installLeaveOutOfTeamCloudWorkspace(store: {
  getState: () => LeaveState
  subscribe: (listener: (state: LeaveState) => void) => () => void
}): () => void {
  let scopeKey = selectOrcaCloudHostScopeKey(store.getState())
  return store.subscribe((state) => {
    const next = selectOrcaCloudHostScopeKey(state)
    if (next === scopeKey) {
      return
    }
    const previous = scopeKey
    scopeKey = next
    if (activeCloudWorkspaceLeftTeam(previous, next, activeHostId(state))) {
      state.setActiveWorktree(null)
    }
  })
}
