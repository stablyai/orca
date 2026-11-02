import {
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { getRecipeVmSshTargetForHost } from '@/lib/recipe-vm-managed-host'

/**
 * Destroys the recipe VM behind a project before the project is removed, so it never leaks.
 * `false` (synchronously) when no VM backs it; otherwise resolves true when the project lived
 * on the VM's managed server, which the VM took with it.
 */
export function destroyRecipeVmBeforeProjectRemoval(
  state: Pick<AppState, 'runtimeEnvironments' | 'worktreesByRepo'>,
  ownerRepo: Pick<Repo, 'id' | 'connectionId'>,
  ownerHostId: ExecutionHostId,
  workspaceIds: string[]
): Promise<boolean> | false {
  const knownServerTarget = getRecipeVmSshTargetForHost(state.runtimeEnvironments, ownerHostId)
  const hasProvisionedRoot = (state.worktreesByRepo[ownerRepo.id] ?? []).some(
    (worktree) =>
      (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === ownerHostId &&
      worktree.ephemeralVmCheckoutMode === 'provisioned-root'
  )
  const directTarget =
    ownerRepo.connectionId && isRuntimeOwnedSshTargetId(ownerRepo.connectionId)
      ? ownerRepo.connectionId
      : null
  if (!knownServerTarget && !hasProvisionedRoot && !directTarget) {
    return false
  }
  return destroyRecipeVm(ownerHostId, workspaceIds, knownServerTarget, directTarget)
}

async function destroyRecipeVm(
  ownerHostId: ExecutionHostId,
  workspaceIds: string[],
  knownServerTarget: string | null,
  directTarget: string | null
): Promise<boolean> {
  const serverTarget =
    knownServerTarget ??
    // Why: the renderer's catalog may predate the server the VM's first connect deployed.
    (ownerHostId.startsWith('runtime:')
      ? getRecipeVmSshTargetForHost(await window.api.runtimeEnvironments.list(), ownerHostId)
      : null)
  const targetId = serverTarget ?? directTarget
  if (!targetId) {
    return false
  }
  // Why host-scoped: another VM's server can publish the same raw workspace id.
  const cleanup = await cleanupEphemeralVmRuntimesForDeleted({
    hostScopedWorkspaces: workspaceIds.map((workspaceId) => ({
      workspaceId,
      executionHostId: ownerHostId
    })),
    runtimeOwnedSshTargetIds: [targetId]
  })
  if (cleanup.retainedSshTargetIds.includes(targetId)) {
    throw new Error('The cloud VM could not be destroyed. Retry cleanup before removing it.')
  }
  return serverTarget !== null
}
