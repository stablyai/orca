import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { gateAndReseedEmptyWorkspace } from '@/lib/worktree-activation-gated-empty-reseed'

/** Restore a dismissed picker's missing surface only while its workspace and host remain active. */
export function restoreWorktreeCreateMenuSurface(
  worktreeId: string,
  executionHostId: ExecutionHostId
): void {
  const state = useAppStore.getState()
  if (
    state.activeWorktreeId !== worktreeId ||
    state.activeWorkspaceExecutionHostId !== executionHostId
  ) {
    return
  }
  gateAndReseedEmptyWorkspace(worktreeId, {
    callerProvidesSurface: false,
    seedUserDefaultSurface: false,
    executionHostId
  })
}
