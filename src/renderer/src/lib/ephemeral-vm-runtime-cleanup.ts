import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'

/**
 * Tear down the ephemeral-VM runtimes backing a set of deleted workspaces (and,
 * optionally, runtimes pinned to a removed repo's runtime-owned SSH target).
 *
 * Centralized because both the per-workspace delete (`removeWorktree`) and the
 * project removal (`removeProject`) must clean up the runtime — an SSH-mode
 * per-workspace-env's workspace is the repo's *main* worktree, so deleting it
 * routes through project removal, which must not leak the live Docker/VM and its
 * hidden SSH target.
 *
 * Returns the runtime-owned SSH target ids that were destroyed so the caller can
 * purge the now-orphaned project that pointed at them.
 */
export async function cleanupEphemeralVmRuntimesForDeleted(args: {
  workspaceIds?: readonly string[]
  // Raw runtime-owned SSH target ids (e.g. a removed repo's connectionId) whose
  // backing runtime should also be torn down, even if no workspace id matched.
  runtimeOwnedSshTargetIds?: readonly string[]
}): Promise<string[]> {
  const destroyedSshTargetIds: string[] = []
  try {
    const workspaceIdSet = new Set(args.workspaceIds ?? [])
    const sshTargetIdSet = new Set(
      (args.runtimeOwnedSshTargetIds ?? []).filter((id) => isRuntimeOwnedSshTargetId(id))
    )
    const runtimes = await window.api.ephemeralVm.listRuntimes()
    const matchingRuntimes = runtimes.filter(
      (runtime) =>
        runtime.cleanupStatus !== 'succeeded' &&
        ((runtime.workspaceId !== undefined && workspaceIdSet.has(runtime.workspaceId)) ||
          (runtime.sshTargetId !== undefined && sshTargetIdSet.has(runtime.sshTargetId)))
    )
    for (const runtime of matchingRuntimes) {
      if (runtime.sshTargetId) {
        destroyedSshTargetIds.push(runtime.sshTargetId)
      }
      await window.api.ephemeralVm.cleanup({ runtimeId: runtime.id })
    }
  } catch (error) {
    console.error('Failed to clean up ephemeral VM runtime for deleted workspace:', error)
  }
  return destroyedSshTargetIds
}
