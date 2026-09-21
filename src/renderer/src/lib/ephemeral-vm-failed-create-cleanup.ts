import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

type FailedCreateCleanupActions = {
  deleteProjectHostSetup: (setupId: string) => Promise<unknown>
  cleanupRuntime: (runtimeId: string) => Promise<unknown>
  reportSetupError: (error: unknown) => void
  reportRuntimeError: (error: unknown) => void
}

export async function cleanupFailedEphemeralVmWorkspace(
  request: WorktreeCreationRequest,
  actions: FailedCreateCleanupActions
): Promise<void> {
  if (!request.ephemeralVmRuntimeId) {
    return
  }
  if (
    request.ephemeralVmCheckoutMode === 'provisioned-root' &&
    request.workspaceRunContext?.projectHostSetupId
  ) {
    try {
      const deleted = await actions.deleteProjectHostSetup(
        request.workspaceRunContext.projectHostSetupId
      )
      if (deleted == null) {
        actions.reportSetupError(new Error('Could not confirm project host rollback.'))
        return
      }
    } catch (error) {
      actions.reportSetupError(error)
      return
    }
  }
  try {
    await actions.cleanupRuntime(request.ephemeralVmRuntimeId)
  } catch (error) {
    actions.reportRuntimeError(error)
  }
}
