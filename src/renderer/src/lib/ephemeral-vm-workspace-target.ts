import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../../shared/project-types'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../../../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from '../../../shared/ephemeral-vm-recipe-diagnostics'
import { PROJECT_HOST_SETUP_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { translate } from '@/i18n/i18n'
import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'

export type PrepareEphemeralVmWorkspaceTargetArgs = {
  workspaceRequest?: Record<string, unknown>
  ownerEnvironmentId?: string
  repoId: string
  recipeId: string
  projectId: string
  workspaceName: string
  branch?: string
  ref?: string
  provisionId?: string
  setupExistingFolder: (
    args: ProjectHostSetupExistingFolderArgs
  ) => Promise<ProjectHostSetupResult | null>
}

export type PrepareEphemeralVmWorkspaceTargetResult =
  | {
      ok: true
      setup: ProjectHostSetupResult
      runtimeId: string
      checkoutMode: 'orca-worktree' | 'provisioned-root'
      ownerEnvironmentId?: string
      environmentId?: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: false
      error: string
      stderr: string
    }

export async function prepareEphemeralVmWorkspaceTarget(
  args: PrepareEphemeralVmWorkspaceTargetArgs
): Promise<PrepareEphemeralVmWorkspaceTargetResult> {
  const provisioned = await window.api.ephemeralVm.provision({
    ...(args.ownerEnvironmentId ? { ownerEnvironmentId: args.ownerEnvironmentId } : {}),
    ...(args.ownerEnvironmentId && args.workspaceRequest
      ? { workspaceRequest: args.workspaceRequest }
      : {}),
    repoId: args.repoId,
    recipeId: args.recipeId,
    projectId: args.projectId,
    workspaceName: args.workspaceName,
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.ref ? { ref: args.ref } : {}),
    ...(args.provisionId ? { provisionId: args.provisionId } : {})
  })
  if (!provisioned.ok) {
    return { ok: false, error: provisioned.error, stderr: provisioned.stderr }
  }

  const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult)
  if (checkoutMode === 'provisioned-root' && provisioned.connectionType !== 'ssh') {
    await cleanupProvisionedRuntime(provisioned.runtime.id, args.ownerEnvironmentId)
    return {
      ok: false,
      error: translate(
        'auto.lib.ephemeralVmWorkspaceTarget.provisionedRootRequiresSsh',
        'Provisioned-root recipes currently require a direct SSH connection.'
      ),
      stderr: provisioned.stderr
    }
  }

  const hostId =
    provisioned.connectionType === 'ssh'
      ? toSshExecutionHostId(provisioned.sshTargetId)
      : toRuntimeExecutionHostId(provisioned.environment.id)

  if (provisioned.connectionType === 'orca-server') {
    try {
      await assertRuntimeEnvironmentCapability(
        provisioned.environment.id,
        PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
        'The recipe-created Orca server does not support project setup.'
      )
    } catch (error) {
      await cleanupProvisionedRuntime(provisioned.runtime.id, args.ownerEnvironmentId)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stderr: provisioned.stderr
      }
    }
  }

  let setup: ProjectHostSetupResult | null
  try {
    setup = await args.setupExistingFolder({
      ...(args.ownerEnvironmentId ? { runtimeOwnerEnvironmentId: args.ownerEnvironmentId } : {}),
      projectId: args.projectId,
      hostId,
      path: getEphemeralVmRecipeResultProjectRoot(provisioned.runtime.recipeResult),
      setupMethod: 'imported-existing-folder'
    })
  } catch (error) {
    await cleanupProvisionedRuntime(provisioned.runtime.id, args.ownerEnvironmentId)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: provisioned.stderr
    }
  }
  if (!setup) {
    await cleanupProvisionedRuntime(provisioned.runtime.id, args.ownerEnvironmentId)
    return {
      ok: false,
      error: translate(
        'auto.lib.ephemeralVmWorkspaceTarget.projectRootRegistrationFailed',
        'Failed to register the recipe-created project root on the runtime.'
      ),
      stderr: provisioned.stderr
    }
  }
  setup = {
    ...setup,
    setup: {
      ...setup.setup,
      // Why: the sandbox reports its own checkout as "local"; the desktop app
      // must route follow-up worktree operations back through this runtime.
      hostId: args.ownerEnvironmentId ? toRuntimeExecutionHostId(args.ownerEnvironmentId) : hostId
    }
  }

  const success = {
    ok: true,
    setup,
    runtimeId: provisioned.runtime.id,
    checkoutMode,
    ...(checkoutMode === 'provisioned-root' &&
    provisioned.connectionType === 'ssh' &&
    provisioned.expectedRefHead
      ? { expectedRefHead: provisioned.expectedRefHead }
      : {}),
    stderr: provisioned.stderr,
    warnings: provisioned.warnings
  } satisfies PrepareEphemeralVmWorkspaceTargetResult

  if (args.ownerEnvironmentId) {
    return { ...success, ownerEnvironmentId: args.ownerEnvironmentId }
  }
  return provisioned.connectionType === 'orca-server'
    ? { ...success, environmentId: provisioned.environment.id }
    : success
}

async function cleanupProvisionedRuntime(
  runtimeId: string,
  ownerEnvironmentId?: string
): Promise<void> {
  try {
    await window.api.ephemeralVm.cleanup({
      runtimeId,
      ...(ownerEnvironmentId ? { ownerEnvironmentId } : {})
    })
  } catch {
    // Best effort: the caller still needs the original setup/provisioning error.
  }
}
