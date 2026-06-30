import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../../shared/types'
import {
  getEphemeralVmRecipeResultProjectRoot,
  type EphemeralVmRecipeResultWarning
} from '../../../shared/ephemeral-vm-recipes'
import { PROJECT_HOST_SETUP_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { translate } from '@/i18n/i18n'
import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'

export type PrepareEphemeralVmWorkspaceTargetArgs = {
  repoId: string
  recipeId: string
  projectId: string
  workspaceName: string
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
      environmentId?: string
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
    repoId: args.repoId,
    recipeId: args.recipeId,
    projectId: args.projectId,
    workspaceName: args.workspaceName,
    ...(args.provisionId ? { provisionId: args.provisionId } : {})
  })
  if (!provisioned.ok) {
    return { ok: false, error: provisioned.error, stderr: provisioned.stderr }
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
      await cleanupProvisionedRuntime(provisioned.runtime.id)
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
      projectId: args.projectId,
      hostId,
      path: getEphemeralVmRecipeResultProjectRoot(provisioned.runtime.recipeResult),
      setupMethod: 'imported-existing-folder'
    })
  } catch (error) {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: provisioned.stderr
    }
  }
  if (!setup) {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
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
      hostId
    }
  }

  const success = {
    ok: true,
    setup,
    runtimeId: provisioned.runtime.id,
    stderr: provisioned.stderr,
    warnings: provisioned.warnings
  } satisfies PrepareEphemeralVmWorkspaceTargetResult

  return provisioned.connectionType === 'orca-server'
    ? { ...success, environmentId: provisioned.environment.id }
    : success
}

async function cleanupProvisionedRuntime(runtimeId: string): Promise<void> {
  try {
    await window.api.ephemeralVm.cleanup({ runtimeId })
  } catch {
    // Best effort: the caller still needs the original setup/provisioning error.
  }
}
