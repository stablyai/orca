import { splitWorktreeId } from './worktree/id'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from './ephemeral-vm-recipes'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from './execution-host'

/** A workspace id alone can name unrelated checkouts on different hosts. */
export function findEphemeralVmWorkspaceOwner(
  runtimes: readonly EphemeralVmRuntimeRecord[],
  workspaceId: string,
  hostId: string
): EphemeralVmRuntimeRecord | undefined {
  const matches = runtimes.filter(
    (runtime) =>
      runtimeOwnsWorkspace(runtime, workspaceId) &&
      ((runtime.runtimeEnvironmentId !== undefined &&
        hostId === toRuntimeExecutionHostId(runtime.runtimeEnvironmentId)) ||
        (runtime.sshTargetId !== undefined && hostId === toSshExecutionHostId(runtime.sshTargetId)))
  )
  if (matches.length > 1) {
    throw new Error(
      'Multiple environment recipes own this workspace. Resolve ownership before deleting.'
    )
  }
  return matches[0]
}

function runtimeOwnsWorkspace(runtime: EphemeralVmRuntimeRecord, workspaceId: string): boolean {
  if (runtime.workspaceId !== undefined) {
    return runtime.workspaceId === workspaceId
  }
  // Older desktop root adoptions did not persist a workspace attachment.
  const path = splitWorktreeId(workspaceId)?.worktreePath
  // A write-ahead record whose create never reported back has no root to match.
  const result = runtime.recipeResult
  return Boolean(
    path &&
    result &&
    getEphemeralVmRecipeResultCheckoutMode(result) === 'provisioned-root' &&
    normalizeRuntimePathForComparison(path) ===
      normalizeRuntimePathForComparison(getEphemeralVmRecipeResultProjectRoot(result))
  )
}

/** The VM's primary checkout is the workspace: removing it is removing the machine. */
export function isProvisionedRootRuntime(runtime: EphemeralVmRuntimeRecord): boolean {
  return (
    runtime.recipeResult !== undefined &&
    getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult) === 'provisioned-root'
  )
}
