import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import type { ExecutionHostId } from '../../../shared/execution-host'

type FailedCreateCleanupActions = {
  deleteProjectHostSetup: (setupId: string, hostId: ExecutionHostId) => Promise<unknown>
  /** Resolves with the runtime record; a failed destroy resolves rather than rejects. */
  cleanupRuntime: (runtimeId: string) => Promise<{ cleanupStatus?: string } | undefined>
  reportSetupError: (error: unknown) => void
  reportRuntimeError: (error: unknown) => void
}

/** Resolves false when any cleanup step failed and the VM or its project may remain. */
export async function cleanupFailedEphemeralVmWorkspace(
  request: WorktreeCreationRequest,
  actions: FailedCreateCleanupActions
): Promise<boolean> {
  if (!request.ephemeralVmRuntimeId) {
    return true
  }
  if (
    request.ephemeralVmCheckoutMode === 'provisioned-root' &&
    request.workspaceRunContext?.projectHostSetupId
  ) {
    try {
      const deleted = await actions.deleteProjectHostSetup(
        request.workspaceRunContext.projectHostSetupId,
        request.workspaceRunContext.hostId
      )
      if (deleted == null) {
        actions.reportSetupError(new Error('Could not confirm project host rollback.'))
        return false
      }
    } catch (error) {
      actions.reportSetupError(error)
      return false
    }
  }
  try {
    const runtime = await actions.cleanupRuntime(request.ephemeralVmRuntimeId)
    if (runtime?.cleanupStatus === 'failed') {
      actions.reportRuntimeError(new Error('The VM recipe could not destroy the VM.'))
      return false
    }
    return true
  } catch (error) {
    actions.reportRuntimeError(error)
    return false
  }
}
