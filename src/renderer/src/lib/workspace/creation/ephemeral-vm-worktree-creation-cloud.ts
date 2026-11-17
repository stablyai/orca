// Orca Cloud's part of the VM create: the GitHub access step, the Create press's idempotency key,
// the environment-check context, phase logging, and the failure toast when the sheet isn't shown.
import { toast } from 'sonner'
import type { CloudCreateRendererPhase } from '../../../../../shared/orca-cloud/cloud-create-phases'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { useAppStore } from '@/store/index'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import type { PrepareEphemeralVmWorkspaceTargetResult } from '@/runtime/ephemeral-vm/ephemeral-vm-workspace-target'
import type { CloudEnvironmentCheckContext } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-cloud'
import { ephemeralVmErrorText } from '@/runtime/ephemeral-vm/ephemeral-vm-error-copy'
import { showVmBuildFailureToast } from '@/components/worktree-creation/vm-build-failure-toast'
import { orcaCloudGitHubRepoUrl } from '@/lib/orca-cloud/use-orca-cloud-repo-access'
import { cloudCreateIdempotencyKey } from '@/lib/orca-cloud/cloud-create-intent'
import {
  beginCloudCreateGitHubAccess,
  gateCloudCreateOnGitHubAccess
} from '@/lib/orca-cloud/cloud-create-github-access'
import { applyCloudGitHubAccessToSandbox } from '@/lib/orca-cloud/cloud-create-github-apply'

type Recipe = NonNullable<WorktreeCreationRequest['ephemeralVmRecipe']>
type PreparedTarget = Extract<PrepareEphemeralVmWorkspaceTargetResult, { ok: true }>
type FailedTarget = Extract<PrepareEphemeralVmWorkspaceTargetResult, { ok: false }>

/** Reports a create phase to main's app log (no-op in the web client). */
export function notePhase(creationId: string, phase: CloudCreateRendererPhase): void {
  window.api.ephemeralVm.notePhase?.({ provisionId: creationId, phase })
}

function sourceRepoUrl(recipe: Recipe): string | null {
  return orcaCloudGitHubRepoUrl(
    useAppStore.getState().repos.find((repo) => repo.id === recipe.sourceRepoId)
  )
}

/** The GitHub access step: asked alongside Start sandbox, so it adds nothing when access is fine. */
export function beginCloudCreate(creationId: string, recipe: Recipe): void {
  if (recipe.provider === 'orca-cloud') {
    beginCloudCreateGitHubAccess(creationId, sourceRepoUrl(recipe))
  }
}

/** Orca Cloud creates carry the Create press's Idempotency-Key; other recipes don't. */
export function cloudCreateIdempotency(
  recipeId: string,
  creationId: string
): { idempotencyKey?: string } {
  if (recipeId !== ORCA_CLOUD_RECIPE_ID) {
    return {}
  }
  const key = cloudCreateIdempotencyKey(creationId)
  return key ? { idempotencyKey: key } : {}
}

/** The build sheet explains the failure and offers its fix; toast only when it is not on screen. */
export function notifyVmCreateFailed(creationId: string, failed: FailedTarget): void {
  const state = useAppStore.getState()
  if (state.activePendingCreationId === creationId && selectWorktreeCreationSurfaceShown(state)) {
    return
  }
  const entry = state.pendingWorktreeCreations[creationId]
  if (entry) {
    showVmBuildFailureToast(entry, failed.error, state.repos)
  } else {
    toast.error(ephemeralVmErrorText(failed))
  }
}

/** What the Orca Cloud environment-check gate needs; undefined for recipe VMs. */
export function cloudEnvironmentCheckContext(
  recipe: Recipe,
  request: WorktreeCreationRequest,
  target: PreparedTarget
): CloudEnvironmentCheckContext | undefined {
  if (recipe.provider !== 'orca-cloud') {
    return undefined
  }
  return {
    runtimeId: target.runtimeId,
    // `inherit` follows the project's setup policy, which runs it on create.
    setupRunsOnCreate: request.setupDecision !== 'skip',
    repoId: target.setup.repo.id,
    hostId: target.setup.setup.hostId,
    repoUrl: sourceRepoUrl(recipe)
  }
}

/** "Start on a new sandbox": the stopped create runs again from the top. */
export async function restartVmCreate(creationId: string): Promise<void> {
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    return
  }
  // Lazy: the creation flow imports this module.
  const { retryBackgroundWorktreeCreation } =
    await import('@/lib/workspace/creation/worktree-creation-flow')
  retryBackgroundWorktreeCreation(creationId)
}

/**
 * The GitHub access step: held here, before Open workspace, while the GitHub step asks for access.
 * Resolves false when the create must stop (the caller cleans the VM up).
 */
export async function gateCloudCreateBeforeWorkspace(
  creationId: string,
  recipe: Recipe,
  environmentId: string | undefined
): Promise<boolean> {
  if (recipe.provider !== 'orca-cloud') {
    return true
  }
  const github = await gateCloudCreateOnGitHubAccess(creationId)
  if (!github.proceed || !useAppStore.getState().pendingWorktreeCreations[creationId]) {
    notePhase(creationId, 'failed')
    return false
  }
  if (github.grantedDuringCreate && environmentId) {
    // Granted after the sandbox started: its git gets the token now, not after a restart.
    await applyCloudGitHubAccessToSandbox({ environmentId })
  }
  return true
}
