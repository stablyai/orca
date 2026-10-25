import {
  isRuntimeOwnedSshTargetId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

/** Destroy runtimes for removed workspaces and runtime-owned SSH targets. Share with project removal because SSH-mode main worktrees delete through that path; classify targets so callers purge only confirmed destruction. */
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
  // Also destroy runtimes pinned to these raw SSH target IDs even without a matching workspace.
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
