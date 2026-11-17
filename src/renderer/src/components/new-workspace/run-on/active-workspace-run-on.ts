// A composer opened with no target of its own starts where the active workspace runs. SSH and
// paired hosts already follow through the active project's host-specific repo; a cloud workspace
// maps to its project's checkout here, so Orca Cloud is seeded instead. Seeding counts as an
// explicit target, so a project's remembered Run on can't override it; the user's pick still can.
import { useAppStore } from '@/store/index'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { isOrcaCloudExecutionHostId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { ComposerModalData } from '../composer/composer-modal-data'

export function activeWorkspaceHostId(): string | null {
  const state = useAppStore.getState()
  return state.activeWorktreeId
    ? getKnownExecutionHostIdForWorktree(state, state.activeWorktreeId)
    : null
}

export function withActiveWorkspaceRunOn(
  modalData: ComposerModalData,
  activeHostId: string | null
): ComposerModalData {
  if (
    modalData.initialEphemeralVmRecipeId ||
    modalData.initialWorkspaceTarget ||
    modalData.initialRepoId ||
    modalData.initialProjectGroupId ||
    modalData.initialParentWorktreeId ||
    modalData.recovery ||
    !isOrcaCloudExecutionHostId(activeHostId)
  ) {
    return modalData
  }
  return { ...modalData, initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID }
}
