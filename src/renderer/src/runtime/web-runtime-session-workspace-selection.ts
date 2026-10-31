import {
  commitDesktopNavigation,
  type DesktopNavigationRequest
} from '@/lib/desktop-navigation-request'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import {
  shouldRestoreWebRuntimeSessionWorkspaceSelection,
  type WebRuntimeSessionWorkspaceSelection
} from './web-runtime-session-workspace-routing'

export function selectWebRuntimeSessionWorktree(
  worktreeId: string,
  environmentId: string,
  navigation?: DesktopNavigationRequest | null
): void {
  const select = () =>
    useAppStore.getState().setActiveWorktree(worktreeId, toRuntimeExecutionHostId(environmentId))
  if (navigation === undefined) {
    select()
  } else if (navigation) {
    commitDesktopNavigation(navigation, select)
  }
}

export type WebRuntimeSessionWorkspaceSelectionRollback = {
  previous: WebRuntimeSessionWorkspaceSelection
  applied: WebRuntimeSessionWorkspaceSelection
}

export function readActiveWorkspaceSelection(): WebRuntimeSessionWorkspaceSelection {
  const state = useAppStore.getState()
  return {
    worktreeId: state.activeWorktreeId ?? null,
    executionHostId: state.activeWorkspaceExecutionHostId ?? null
  }
}

export function restoreActiveWorkspaceSelection(
  rollback: WebRuntimeSessionWorkspaceSelectionRollback
): void {
  if (
    !shouldRestoreWebRuntimeSessionWorkspaceSelection({
      ...rollback,
      current: readActiveWorkspaceSelection()
    })
  ) {
    return
  }
  useAppStore
    .getState()
    .setActiveWorktree(rollback.previous.worktreeId, rollback.previous.executionHostId ?? undefined)
}

export function selectWebRuntimeSessionBrowserWorktree(
  worktreeId: string,
  environmentId: string
): void {
  const state = useAppStore.getState()
  if (
    state.activeWorktreeId !== worktreeId ||
    state.activeWorkspaceExecutionHostId !== toRuntimeExecutionHostId(environmentId)
  ) {
    state.setActiveWorktree(worktreeId, toRuntimeExecutionHostId(environmentId))
  }
}
