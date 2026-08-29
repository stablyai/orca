import {
  isRuntimeOwnedSshTargetId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

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
 * Classifies runtime-owned SSH targets so callers purge only confirmed-destroyed projects.
 */
export type EphemeralVmCleanupSummary = {
  destroyedSshTargetIds: string[]
  retainedSshTargetIds: string[]
}

export async function cleanupEphemeralVmRuntimesForDeleted(args: {
  workspaceIds?: readonly string[]
  /** Workspace owners whose same-id siblings on other hosts must survive. */
  hostScopedWorkspaces?: readonly {
    workspaceId: string
    executionHostId: ExecutionHostId
  }[]
  // Raw runtime-owned SSH target ids (e.g. a removed repo's connectionId) whose
  // backing runtime should also be torn down, even if no workspace id matched.
  runtimeOwnedSshTargetIds?: readonly string[]
}): Promise<EphemeralVmCleanupSummary> {
  const destroyedSshTargetIds = new Set<string>()
  const retainedSshTargetIds = new Set<string>()
  try {
    const workspaceIdSet = new Set(args.workspaceIds ?? [])
    const sshTargetIdSet = new Set(
      (args.runtimeOwnedSshTargetIds ?? []).filter((id) => isRuntimeOwnedSshTargetId(id))
    )
    const hostScopedWorkspaceIdentities = new Set(
      (args.hostScopedWorkspaces ?? []).map((target) =>
        composeWorktreeHostIdentity(target.executionHostId, target.workspaceId)
      )
    )
    const runtimes = await window.api.ephemeralVm.listRuntimes()
    const matchingRuntimes = runtimes.filter(
      (runtime) =>
        (runtime.cleanupStatus !== 'succeeded' || runtime.sshTargetId !== undefined) &&
        ((runtime.workspaceId !== undefined && workspaceIdSet.has(runtime.workspaceId)) ||
          (runtime.workspaceId !== undefined &&
            ((runtime.runtimeEnvironmentId !== undefined &&
              hostScopedWorkspaceIdentities.has(
                composeWorktreeHostIdentity(
                  toRuntimeExecutionHostId(runtime.runtimeEnvironmentId),
                  runtime.workspaceId
                )
              )) ||
              (runtime.sshTargetId !== undefined &&
                hostScopedWorkspaceIdentities.has(
                  composeWorktreeHostIdentity(
                    toSshExecutionHostId(runtime.sshTargetId),
                    runtime.workspaceId
                  )
                )))) ||
          (runtime.sshTargetId !== undefined && sshTargetIdSet.has(runtime.sshTargetId)))
    )
    for (const runtime of matchingRuntimes) {
      try {
        const cleaned = await window.api.ephemeralVm.cleanup({ runtimeId: runtime.id })
        if (runtime.sshTargetId) {
          const targetIds = cleaned.sshTargetId ? retainedSshTargetIds : destroyedSshTargetIds
          targetIds.add(runtime.sshTargetId)
        }
      } catch (error) {
        console.error('Failed to clean up ephemeral VM runtime for deleted workspace:', error)
        if (runtime.sshTargetId) {
          retainedSshTargetIds.add(runtime.sshTargetId)
        }
      }
    }
  } catch (error) {
    console.error('Failed to clean up ephemeral VM runtime for deleted workspace:', error)
    for (const targetId of args.runtimeOwnedSshTargetIds ?? []) {
      if (isRuntimeOwnedSshTargetId(targetId)) {
        retainedSshTargetIds.add(targetId)
      }
    }
  }
  return {
    destroyedSshTargetIds: [...destroyedSshTargetIds],
    retainedSshTargetIds: [...retainedSshTargetIds]
  }
}
