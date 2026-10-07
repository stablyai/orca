import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

/**
 * True only when the pane's shell runs on this client. An SSH or remote host, or one not yet
 * known, must not be described with this client's OS and shell.
 */
export function isTerminalPaneOnClient(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): boolean {
  return getKnownExecutionHostIdForWorktree(state, worktreeId) === LOCAL_EXECUTION_HOST_ID
}
