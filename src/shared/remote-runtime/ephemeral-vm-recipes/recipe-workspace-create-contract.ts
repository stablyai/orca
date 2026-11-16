import type { EphemeralVmCheckoutMode } from '../../workspace-setup/orca-yaml-hook-types'
import type { EnvironmentDoctorCheck } from '../../workspace-setup/environment-doctor/environment-doctor-types'
import type { RuntimeWorktreeRecord } from '../../worktree/catalog/runtime-worktree-contracts'
import type { RecipeEnvironmentProvisionPhase } from './recipe-environment-provision-result'

/** Desktop-only RPC: create a workspace on a new environment from one of a repo's orca.yaml recipes. */
export const WORKTREE_CREATE_ON_RECIPE_METHOD = 'worktree.createOnRecipe' as const

/** Named steps of a recipe workspace create, in the order they run, as the CLI prints them. */
export const RECIPE_WORKSPACE_CREATE_PHASES = {
  'resolving-start-ref': 'Resolving the start ref',
  'running-create': "Running the recipe's create step",
  connecting: 'Connecting to the new environment',
  'registering-project': 'Registering the project on the environment',
  'checking-environment': 'Checking the environment',
  'creating-workspace': 'Creating the workspace',
  'destroying-after-failure': 'Destroying the environment after the failure'
} as const satisfies Record<RecipeEnvironmentProvisionPhase, string> & Record<string, string>

export type RecipeWorkspaceCreatePhase = keyof typeof RECIPE_WORKSPACE_CREATE_PHASES

export function isRecipeWorkspaceCreatePhase(value: unknown): value is RecipeWorkspaceCreatePhase {
  return typeof value === 'string' && Object.hasOwn(RECIPE_WORKSPACE_CREATE_PHASES, value)
}

/** RPC error code of a failed recipe create; `data` is RecipeWorkspaceCreateFailureData. */
export const RECIPE_WORKSPACE_CREATE_FAILED_CODE = 'recipe_workspace_create_failed' as const
/** Settings > Experimental > Cloud VM is off, so nothing ran. */
export const CLOUD_VMS_DISABLED_CODE = 'cloud_vms_disabled' as const

/** What became of the environment a failed create had started. */
export type RecipeEnvironmentOutcome = 'destroyed' | 'destroy-failed' | 'left-running'

export type RecipeWorkspaceCreateFailureData = {
  /** The step that failed. */
  phase: RecipeWorkspaceCreatePhase
  recipeId: string
  /** The recipe failure catalog code (ephemeral-vm-failure-copy) when the recipe itself failed. */
  failureCode?: string
  failureParams?: Record<string, string | number>
  /** Present once the environment's create step finished. */
  runtimeId?: string
  environment?: RecipeEnvironmentOutcome
  destroyError?: string
  /** The failed environment checks when they stopped the create. */
  environmentChecks?: EnvironmentDoctorCheck[]
}

/** The workspace a recipe create made, with the host the recipe created for it. */
export type RecipeWorkspaceCreateResult = {
  worktree: RuntimeWorktreeRecord
  host: {
    /** The new host, `runtime:<environmentId>`; host and workspace commands accept it. */
    id: string
    environmentId: string
    /** The desktop's record of the environment (Settings > Cloud VMs); sleep, wake and delete use it. */
    runtimeId: string
    recipeId: string
    checkoutMode: EphemeralVmCheckoutMode
  }
  /** The recipe result's warnings, the new host's setup warning, and anything sleep/wake would miss. */
  warnings?: string[]
}
