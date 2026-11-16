import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  cleanupFailedRecipeWorkspace,
  type FailedRecipeWorkspaceCleanupActions
} from '../../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-failed-create-cleanup'

/** Resolves false when any cleanup step failed and the VM or its project may remain. */
export async function cleanupFailedEphemeralVmWorkspace(
  request: WorktreeCreationRequest,
  actions: FailedRecipeWorkspaceCleanupActions
): Promise<boolean> {
  return cleanupFailedRecipeWorkspace(
    {
      runtimeId: request.ephemeralVmRuntimeId,
      checkoutMode: request.ephemeralVmCheckoutMode,
      projectHostSetupId: request.workspaceRunContext?.projectHostSetupId,
      hostId: request.workspaceRunContext?.hostId
    },
    actions
  )
}
