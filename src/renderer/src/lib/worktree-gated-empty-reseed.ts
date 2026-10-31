import {
  canPresentDesktopNavigation,
  type DesktopNavigationRequest
} from './desktop-navigation-request'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { isEmptyWorkspaceDefaultSurfacePending } from './empty-workspace-default-surface-claims'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'

export type GatedEmptyWorkspaceReseedIntent = {
  navigation?: DesktopNavigationRequest
  callerProvidesSurface: boolean
  seedUserDefaultSurface: boolean
  executionHostId?: ExecutionHostId
}

/** Re-seed after an empty gate unless its activation owns the surface or no longer owns the host. */
export function reseedGatedEmptyWorkspace(
  workspaceKey: string,
  intent: GatedEmptyWorkspaceReseedIntent
): void {
  const { callerProvidesSurface, seedUserDefaultSurface, executionHostId } = intent
  const state = useAppStore.getState()
  if (
    callerProvidesSurface === true ||
    isEmptyWorkspaceDefaultSurfacePending(workspaceKey) ||
    state.activeWorktreeId !== workspaceKey ||
    (executionHostId !== undefined && state.activeWorkspaceExecutionHostId !== executionHostId)
  ) {
    return
  }
  ensureWorktreeHasInitialTerminal(
    state,
    workspaceKey,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      reseedEmptiedWorkspace: true,
      navigation: intent.navigation,
      ...(intent.navigation && !canPresentDesktopNavigation(intent.navigation)
        ? { activateCreatedTabs: false }
        : {}),
      ...(seedUserDefaultSurface ? { seedUserDefaultSurface: true } : {})
    }
  )
}
