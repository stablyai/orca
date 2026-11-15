import { listEphemeralVmRuntimes } from './ephemeral-vm-runtime-store'
import {
  hasEphemeralVmRecipeResult,
  type EphemeralVmProvisionedRuntimeRecord
} from './ephemeral-vm-runtimes'

/** The live recipe VM behind a workspace, if it has one its recipe can suspend and resume. */
export function findWorkspaceEphemeralVmRuntime(
  userDataPath: string,
  workspaceId: string
): (EphemeralVmProvisionedRuntimeRecord & { repoId: string }) | undefined {
  // Write-ahead rows never got a recipe result, so there is no VM to suspend or resume.
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (entry): entry is EphemeralVmProvisionedRuntimeRecord =>
      entry.workspaceId === workspaceId &&
      hasEphemeralVmRecipeResult(entry) &&
      entry.status !== 'cleaned' &&
      entry.status !== 'cleanup_pending'
  )
  return runtime?.repoId ? { ...runtime, repoId: runtime.repoId } : undefined
}
