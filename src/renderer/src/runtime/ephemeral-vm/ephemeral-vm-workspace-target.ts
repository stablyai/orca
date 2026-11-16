import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../../../shared/project/project-types'
import '../../../../shared/remote-runtime/protocol/protocol-version'
import {
  prepareRecipeWorkspaceTarget,
  type RecipeWorkspaceTargetResult
} from '../../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-target'
import { translate } from '@/i18n/i18n'
import { ephemeralVmErrorText } from '@/runtime/ephemeral-vm/ephemeral-vm-error-copy'
import { assertRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'

export type PrepareEphemeralVmWorkspaceTargetArgs = {
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

export type PrepareEphemeralVmWorkspaceTargetResult = RecipeWorkspaceTargetResult

export async function prepareEphemeralVmWorkspaceTarget(
  args: PrepareEphemeralVmWorkspaceTargetArgs
): Promise<PrepareEphemeralVmWorkspaceTargetResult> {
  return prepareRecipeWorkspaceTarget(
    { projectId: args.projectId },
    {
      provision: () =>
        window.api.ephemeralVm.provision({
          repoId: args.repoId,
          recipeId: args.recipeId,
          projectId: args.projectId,
          workspaceName: args.workspaceName,
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.ref ? { ref: args.ref } : {}),
          ...(args.provisionId ? { provisionId: args.provisionId } : {})
        }),
      describeProvisionFailure: ephemeralVmErrorText,
      assertEnvironmentCapability: assertRuntimeEnvironmentCapability,
      setupExistingFolder: args.setupExistingFolder,
      cleanupRuntime: (runtimeId) => window.api.ephemeralVm.cleanup({ runtimeId }),
      copy: {
        provisionedRootRequiresSsh: () =>
          translate(
            'auto.lib.ephemeralVmWorkspaceTarget.provisionedRootRequiresSsh',
            'Provisioned-root recipes currently require a direct SSH connection.'
          ),
        provisionedRootNeedsUpdate: () =>
          translate(
            'auto.lib.ephemeralVm.provisionedRootNeedsUpdate',
            'The Orca server on this VM cannot adopt a provisioned root. Update Orca on the VM.'
          ),
        projectRootRegistrationFailed: () =>
          translate(
            'auto.lib.ephemeralVmWorkspaceTarget.projectRootRegistrationFailed',
            'Failed to register the recipe-created project root on the runtime.'
          )
      }
    }
  )
}
