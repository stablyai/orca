import type { GlobalSettings } from '../../../../shared/types'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getSettingsForWorktreeRuntimeOwner
} from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

type RightSidebarRuntimeOwnerState = Pick<
  AppState,
  | 'settings'
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function getRightSidebarWorktreeRuntimeSettingsFromState(
  store: RightSidebarRuntimeOwnerState,
  worktreeId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  const settings = getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  const hasExplicitRuntimeOwner =
    getExplicitRuntimeEnvironmentIdForWorktree(store, worktreeId) !== null
  const connectionId = getConnectionIdFromState(store, worktreeId ?? null)
  // Why: folder SSH ownership can be inferred from child repos before the
  // folder record carries provenance; it still outranks a merely focused runtime.
  return connectionId && !hasExplicitRuntimeOwner
    ? { ...settings, activeRuntimeEnvironmentId: null }
    : settings
}

export function getRightSidebarWorktreeRuntimeSettings(
  worktreeId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  const store = useAppStore.getState()
  // Why: right-sidebar file/git actions operate on the selected workspace.
  // Route by that workspace owner so global focused-host changes cannot retarget them.
  return getRightSidebarWorktreeRuntimeSettingsFromState(store, worktreeId)
}
