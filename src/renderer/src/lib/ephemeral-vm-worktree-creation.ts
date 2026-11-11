import { toast } from 'sonner'
import type { CloudCreateRendererPhase } from '../../../shared/orca-cloud/cloud-create-phases'
import { useAppStore } from '@/store'
import { prepareEphemeralVmWorkspaceTarget } from '@/lib/ephemeral-vm-workspace-target'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { getProjectIdentityKey } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { cleanupFailedEphemeralVmWorkspace } from '@/lib/ephemeral-vm-failed-create-cleanup'
import { gateVmCreateOnEnvironmentCheck } from '@/lib/ephemeral-vm-environment-check'
import { orcaCloudGitHubRepoUrl } from '@/lib/orca-cloud/use-orca-cloud-repo-access'
import { showVmBuildFailureToast } from '@/components/worktree-creation/vm-build-failure-toast'
import { ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import {
  hideVmCreateCheckout,
  settleVmCreateCheckoutAfterCleanup
} from '@/lib/vm-create-hidden-checkouts'
import {
  appendProvisioningLog,
  appendProvisioningWarnings
} from '@/lib/pending-creation-provisioning-log'
import { cloudCreateIdempotencyKey } from '@/lib/orca-cloud/cloud-create-intent'
import { ORCA_CLOUD_RECIPE_ID } from '../../../shared/hosted-sandbox/orca-cloud-recipe-id'

export async function prepareRequestForCreate(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<WorktreeCreationRequest | null> {
  if (request.ephemeralVmRecipe && !request.ephemeralVmRuntimeId) {
    return prepareEphemeralVmRecipeRequest(creationId, request, request.ephemeralVmRecipe)
  }
  return request
}

async function prepareEphemeralVmRecipeRequest(
  creationId: string,
  request: WorktreeCreationRequest,
  recipe: NonNullable<WorktreeCreationRequest['ephemeralVmRecipe']>
): Promise<WorktreeCreationRequest | null> {
  const store = useAppStore.getState()
  if (recipe.checkoutMode === 'provisioned-root' && request.sparseCheckout) {
    store.updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: getProvisionedRootSparseCheckoutError()
    })
    return null
  }
  store.updatePendingWorktreeCreation(creationId, {
    phase: 'provisioning-vm',
    provisioningLog: '',
    provisioningLogStamps: [],
    // A retry provisions a new VM; the sheet must not act on the last one.
    vmEnvironmentId: undefined
  })
  const unsubscribeProvisionEvents = window.api.ephemeralVm.onProvisionEvent?.((event) => {
    if (event.provisionId !== creationId || event.stream !== 'stderr') {
      return
    }
    appendProvisioningLog(creationId, event.chunk)
  })
  let preparedTarget: Awaited<ReturnType<typeof prepareEphemeralVmWorkspaceTarget>>
  try {
    const sourceRepo = store.repos.find((repo) => repo.id === recipe.sourceRepoId)
    preparedTarget = await prepareEphemeralVmWorkspaceTarget({
      repoId: recipe.sourceRepoId,
      recipeId: recipe.recipeId,
      projectId: resolvePortableEphemeralVmProjectId(sourceRepo) ?? recipe.projectId,
      workspaceName: request.name,
      ...(recipe.checkoutMode === 'provisioned-root'
        ? {
            branch: request.branchNameOverride ?? request.name,
            ...(request.baseBranch ? { ref: request.baseBranch } : {})
          }
        : {}),
      provisionId: creationId,
      ...cloudCreateIdempotency(recipe.recipeId, creationId),
      setupExistingFolder: async (args) => {
        // The VM's checkout folder is named "project"; register it under the real project's name.
        const displayName =
          useAppStore.getState().projects.find((project) => project.id === args.projectId)
            ?.displayName ?? sourceRepo?.displayName
        // Why: the user picked an existing project; the VM's checkout joining it is not a new project.
        const setup = await store.setupProjectExistingFolder(
          displayName ? { ...args, displayName } : args,
          { quiet: true }
        )
        if (setup) {
          // Why: until the create adopts it, the VM's primary checkout is not a workspace; the pending row stands for it.
          hideVmCreateCheckout(creationId, { repoId: setup.repo.id, path: setup.repo.path })
        }
        return setup
      }
    })
  } finally {
    unsubscribeProvisionEvents?.()
  }
  if (!preparedTarget.ok) {
    notePhase(creationId, 'failed')
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return null
    }
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: preparedTarget.error,
      errorCode: preparedTarget.errorCode
    })
    // The build sheet explains the failure and offers its fix; toast only when it is not on screen.
    const state = useAppStore.getState()
    if (
      state.activePendingCreationId !== creationId ||
      !selectWorktreeCreationSurfaceShown(state)
    ) {
      const failed = state.pendingWorktreeCreations[creationId]
      if (failed) {
        showVmBuildFailureToast(failed, preparedTarget.error, state.repos)
      } else {
        toast.error(ephemeralVmErrorText(preparedTarget))
      }
    }
    return null
  }
  appendProvisioningWarnings(creationId, preparedTarget.warnings)
  if (preparedTarget.environmentId) {
    useAppStore
      .getState()
      .updatePendingWorktreeCreation(creationId, { vmEnvironmentId: preparedTarget.environmentId })
    // Why: the VM's first connect may have just deployed this server; host badges and removal read it.
    notePhase(creationId, 'runtime-catalog-start')
    try {
      useAppStore.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
    } catch {
      // A stale catalog only delays host badges; removal re-reads it.
    }
    notePhase(creationId, 'runtime-catalog-end')
  }
  const preparedRequest: WorktreeCreationRequest = {
    ...request,
    repoId: preparedTarget.setup.repo.id,
    ...(preparedTarget.checkoutMode === 'provisioned-root'
      ? { baseBranch: request.baseBranch, compareBaseRef: request.compareBaseRef }
      : getEphemeralVmPortableBaseSelection(request)),
    ephemeralVmRuntimeId: preparedTarget.runtimeId,
    ephemeralVmCheckoutMode: preparedTarget.checkoutMode,
    ...(preparedTarget.expectedRefHead
      ? { ephemeralVmExpectedRefHead: preparedTarget.expectedRefHead }
      : {}),
    ...(preparedTarget.environmentId
      ? { ephemeralVmRuntimeEnvironmentId: preparedTarget.environmentId }
      : {}),
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: preparedTarget.setup.setup.projectId,
      hostId: preparedTarget.setup.setup.hostId,
      projectHostSetupId: preparedTarget.setup.setup.id,
      repoId: preparedTarget.setup.repo.id,
      path: preparedTarget.setup.repo.path
    }
  }
  notePhase(creationId, 'env-check-start')
  const gate = !useAppStore.getState().pendingWorktreeCreations[creationId]
    ? 'stop'
    : !preparedTarget.environmentId
      ? 'proceed'
      : await gateVmCreateOnEnvironmentCheck(
          creationId,
          preparedTarget.environmentId,
          preparedTarget.setup.repo.path,
          recipe.provider === 'orca-cloud'
            ? {
                runtimeId: preparedTarget.runtimeId,
                // `inherit` follows the project's setup policy, which runs it on create.
                setupRunsOnCreate: request.setupDecision !== 'skip',
                repoId: preparedTarget.setup.repo.id,
                hostId: preparedTarget.setup.setup.hostId,
                repoUrl: orcaCloudGitHubRepoUrl(
                  useAppStore.getState().repos.find((repo) => repo.id === recipe.sourceRepoId)
                )
              }
            : undefined
        )
  notePhase(creationId, gate === 'proceed' ? 'env-check-end' : 'failed')
  if (gate !== 'proceed') {
    await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest, creationId)
    if (gate === 'restart' && useAppStore.getState().pendingWorktreeCreations[creationId]) {
      // Lazy: the creation flow imports this module.
      const { retryBackgroundWorktreeCreation } =
        await import('@/lib/workspace/creation/worktree-creation-flow')
      retryBackgroundWorktreeCreation(creationId)
    }
    return null
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    phase: 'fetching',
    request: preparedRequest
  })
  notePhase(creationId, 'workspace-create-start')
  return preparedRequest
}

function getEphemeralVmPortableBaseSelection(
  request: WorktreeCreationRequest
): Pick<WorktreeCreationRequest, 'baseBranch' | 'compareBaseRef'> {
  const keepBaseBranch =
    request.linkedPR !== undefined ||
    request.linkedGitLabMR !== undefined ||
    request.linkedBitbucketPR !== undefined ||
    request.linkedAzureDevOpsPR !== undefined ||
    request.linkedGiteaPR !== undefined ||
    Boolean(request.compareBaseRef) ||
    Boolean(request.pushTarget) ||
    Boolean(request.branchNameOverride)
  if (keepBaseBranch) {
    return {
      ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
      ...(request.compareBaseRef ? { compareBaseRef: request.compareBaseRef } : {})
    }
  }
  // A fresh VM checkout may lack source local/pinned branches; use its default unless the user chose a provider-backed start point.
  return { baseBranch: undefined, compareBaseRef: undefined }
}

export async function attachEphemeralVmRuntimeToWorkspace(
  request: WorktreeCreationRequest,
  workspaceId: string
): Promise<void> {
  if (!request.ephemeralVmRuntimeId || request.ephemeralVmCheckoutMode === 'provisioned-root') {
    return
  }
  try {
    await window.api.ephemeralVm.attachWorkspace({
      runtimeId: request.ephemeralVmRuntimeId,
      workspaceId
    })
    if (request.ephemeralVmRuntimeEnvironmentId) {
      void useAppStore
        .getState()
        .refreshRuntimeEnvironmentStatus(request.ephemeralVmRuntimeEnvironmentId)
    }
  } catch (error) {
    console.error('Failed to attach ephemeral VM runtime to workspace:', error)
  }
}

function resolvePortableEphemeralVmProjectId(repo: Repo | undefined): string | null {
  if (!repo) {
    return null
  }
  // Reuse canonical github: identity but reject git:/repo: fallbacks to retain non-GitHub null behavior.
  const key = getProjectIdentityKey(repo)
  return key.startsWith('github:') ? key : null
}

/** A VM cleaned up stays out of the sidebar; one that could not be is shown again so the user can remove it. */
export async function cleanupEphemeralVmRuntimeForFailedCreate(
  request: WorktreeCreationRequest,
  creationId: string
): Promise<void> {
  const cleanedUp = await cleanupFailedEphemeralVmWorkspace(request, {
    deleteProjectHostSetup: (setupId, hostId) =>
      useAppStore.getState().deleteProjectHostSetup({ setupId, hostId }),
    cleanupRuntime: (runtimeId) => window.api.ephemeralVm.cleanup({ runtimeId }),
    reportSetupError: (error) =>
      console.error('Failed to remove provisioned-root project setup:', error),
    reportRuntimeError: (error) =>
      console.error(
        'Failed to clean up ephemeral VM runtime after workspace creation failed:',
        error
      )
  })
  settleVmCreateCheckoutAfterCleanup(creationId, cleanedUp)
}

export function getProvisionedRootSparseCheckoutError(): string {
  return translate(
    'auto.lib.ephemeralVmWorktreeCreation.sparseCheckoutUnsupported',
    'Provisioned-root recipes do not support sparse checkout.'
  )
}

/** Orca Cloud creates carry the Create press's Idempotency-Key; other recipes don't. */
function cloudCreateIdempotency(recipeId: string, creationId: string): { idempotencyKey?: string } {
  if (recipeId !== ORCA_CLOUD_RECIPE_ID) {
    return {}
  }
  const key = cloudCreateIdempotencyKey(creationId)
  return key ? { idempotencyKey: key } : {}
}

/** N-01: reports a create phase to main's app log (no-op in the web client). */
function notePhase(creationId: string, phase: CloudCreateRendererPhase): void {
  window.api.ephemeralVm.notePhase?.({ provisionId: creationId, phase })
}
