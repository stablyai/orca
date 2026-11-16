import type { ExecutionHostId } from '../../execution-host/execution-host'
import type { EphemeralVmCheckoutMode } from '../../workspace-setup/orca-yaml-hook-types'

/** What a failed recipe create registered: its VM and, for provisioned roots, the project setup. */
export type FailedRecipeWorkspace = {
  runtimeId?: string
  checkoutMode?: EphemeralVmCheckoutMode
  projectHostSetupId?: string
  hostId?: ExecutionHostId
}

export type FailedRecipeWorkspaceCleanupActions = {
  deleteProjectHostSetup: (setupId: string, hostId: ExecutionHostId) => Promise<unknown>
  /** Resolves with the runtime record; a failed destroy resolves rather than rejects. */
  cleanupRuntime: (runtimeId: string) => Promise<{ cleanupStatus?: string } | undefined>
  reportSetupError: (error: unknown) => void
  reportRuntimeError: (error: unknown) => void
}

/** Resolves false when any cleanup step failed and the VM or its project may remain. */
export async function cleanupFailedRecipeWorkspace(
  created: FailedRecipeWorkspace,
  actions: FailedRecipeWorkspaceCleanupActions
): Promise<boolean> {
  if (!created.runtimeId) {
    return true
  }
  if (created.checkoutMode === 'provisioned-root' && created.projectHostSetupId && created.hostId) {
    try {
      const deleted = await actions.deleteProjectHostSetup(
        created.projectHostSetupId,
        created.hostId
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
    const runtime = await actions.cleanupRuntime(created.runtimeId)
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
