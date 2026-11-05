import { attachEphemeralVmRuntimeToWorkspace } from '@/lib/ephemeral-vm-worktree-creation'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { persistCreatedWorkspacePluginTaskLink } from '@/lib/plugin-task-workspace-link'

/** Binds what the request carried (a VM runtime, a plugin task) to the workspace it created. */
export function attachCreatedWorkspaceState(
  request: WorktreeCreationRequest,
  worktreeId: string
): Promise<void> {
  persistCreatedWorkspacePluginTaskLink(worktreeId, request.linkedPluginTask)
  // Why returned, not awaited here: creation must take no more turns than awaiting the attach alone.
  return attachEphemeralVmRuntimeToWorkspace(request, worktreeId)
}
