import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../execution-host/execution-host'
import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../project/project-types'
import type { RuntimeCapability } from '../protocol/protocol-version'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY
} from '../protocol/worktree-runtime-capabilities'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from './ephemeral-vm-recipe-diagnostics'
import type { RecipeEnvironmentProvisionResult } from './recipe-environment-provision-result'
import type { Repo } from '../../repository/repo-types'
import { getProjectIdentityKey } from '../../project/host-setup/project-host-setup-projection'

type ProvisionedEnvironment = Extract<RecipeEnvironmentProvisionResult, { ok: true }>
type ProvisionFailure = Extract<RecipeEnvironmentProvisionResult, { ok: false }>

export type RecipeWorkspaceTargetResult =
  | {
      ok: true
      setup: ProjectHostSetupResult
      runtimeId: string
      checkoutMode: 'orca-worktree' | 'provisioned-root'
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

/** Where each step runs: the new-workspace dialog passes its renderer APIs, the CLI's create main's. */
export type RecipeWorkspaceTargetPorts = {
  provision: () => Promise<RecipeEnvironmentProvisionResult>
  describeProvisionFailure: (failure: ProvisionFailure) => string
  assertEnvironmentCapability: (
    environmentId: string,
    capability: RuntimeCapability,
    message: string
  ) => Promise<void>
  setupExistingFolder: (
    args: ProjectHostSetupExistingFolderArgs
  ) => Promise<ProjectHostSetupResult | null>
  /** Destroys the provisioned VM; best effort, so the caller keeps the original error. */
  cleanupRuntime: (runtimeId: string) => Promise<unknown>
  copy: {
    provisionedRootRequiresSsh: () => string
    provisionedRootNeedsUpdate: () => string
    projectRootRegistrationFailed: () => string
  }
  onRegisteringProject?: () => void
}

/**
 * Provisions a recipe's environment and registers its project root on the host the recipe
 * created. Every failure after the VM exists destroys it. Shared by the new-workspace dialog and
 * `orca worktree create --on recipe:<id>`, so both create on the same host the same way.
 */
export async function prepareRecipeWorkspaceTarget(
  args: { projectId: string },
  ports: RecipeWorkspaceTargetPorts
): Promise<RecipeWorkspaceTargetResult> {
  const provisioned = await ports.provision()
  if (!provisioned.ok) {
    return {
      ok: false,
      error: ports.describeProvisionFailure(provisioned),
      stderr: provisioned.stderr
    }
  }
  const fail = async (error: string): Promise<RecipeWorkspaceTargetResult> => {
    try {
      await ports.cleanupRuntime(provisioned.runtime.id)
    } catch {
      // Best effort: the caller still needs the original setup/provisioning error.
    }
    return { ok: false, error, stderr: provisioned.stderr }
  }

  const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult)
  if (checkoutMode === 'provisioned-root' && provisioned.connectionType !== 'ssh') {
    return fail(ports.copy.provisionedRootRequiresSsh())
  }

  const { hostId, environmentId } = recipeWorkspaceHost(provisioned)
  ports.onRegisteringProject?.()
  if (environmentId) {
    try {
      await ports.assertEnvironmentCapability(
        environmentId,
        PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
        'The recipe-created Orca server does not support project setup.'
      )
      if (checkoutMode === 'provisioned-root') {
        await ports.assertEnvironmentCapability(
          environmentId,
          WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY,
          ports.copy.provisionedRootNeedsUpdate()
        )
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
  let setup: ProjectHostSetupResult | null
  try {
    setup = await ports.setupExistingFolder({
      projectId: args.projectId,
      hostId,
      path: getEphemeralVmRecipeResultProjectRoot(provisioned.runtime.recipeResult),
      setupMethod: 'imported-existing-folder'
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (!setup) {
    return fail(ports.copy.projectRootRegistrationFailed())
  }
  setup = {
    ...setup,
    setup: {
      ...setup.setup,
      // The sandbox calls its checkout local; desktop follow-up operations must still route through this runtime.
      hostId
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
  } satisfies RecipeWorkspaceTargetResult

  return environmentId ? { ...success, environmentId } : success
}

/** A VM whose SSH host runs a managed server keeps its workspace on that server. */
function recipeWorkspaceHost(provisioned: ProvisionedEnvironment): {
  hostId: ExecutionHostId
  environmentId?: string
} {
  if (provisioned.connectionType === 'orca-server') {
    const environmentId = provisioned.environment.id
    return { hostId: toRuntimeExecutionHostId(environmentId), environmentId }
  }
  if (provisioned.environmentId) {
    const { environmentId } = provisioned
    return { hostId: toRuntimeExecutionHostId(environmentId), environmentId }
  }
  return { hostId: toSshExecutionHostId(provisioned.sshTargetId) }
}

/** The source repo's canonical github: identity, so the VM's project groups with it; null otherwise. */
export function resolvePortableRecipeProjectId(repo: Repo | undefined): string | null {
  if (!repo) {
    return null
  }
  // Reuse canonical github: identity but reject git:/repo: fallbacks to retain non-GitHub null behavior.
  const key = getProjectIdentityKey(repo)
  return key.startsWith('github:') ? key : null
}
