import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

/** Navigate from a worktree reference in either sidebar back to the workspace surface. */
export function jumpToWorktreeFromSidebar(
  worktreeId: string,
  options?: { executionHostId?: ExecutionHostId }
): boolean {
  // Filters stay as set: the sidebar lists the active workspace anyway, marked hidden.
  const activated = activateAndRevealWorkspace(worktreeId, {
    navigationIntent: 'user-open',
    showWorkspaceList: true,
    ...(options?.executionHostId ? { executionHostId: options.executionHostId } : {})
  })
  return activated !== false
}
