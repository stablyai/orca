/** Named steps of creating a workspace on a fresh recipe environment, in the order they run. */
export const RECIPE_WORKSPACE_CREATE_PHASES = {
  'resolving-start-ref': 'Resolving the start ref',
  'running-create': "Running the recipe's create step",
  connecting: 'Connecting to the new environment',
  'checking-host': 'Checking Orca on the environment',
  'registering-project': 'Registering the project on the environment',
  'creating-workspace': 'Creating the workspace',
  'destroying-after-failure': 'Destroying the environment after a failure'
} as const

export type RecipeWorkspaceCreatePhase = keyof typeof RECIPE_WORKSPACE_CREATE_PHASES

export function isRecipeWorkspaceCreatePhase(value: unknown): value is RecipeWorkspaceCreatePhase {
  return typeof value === 'string' && Object.hasOwn(RECIPE_WORKSPACE_CREATE_PHASES, value)
}

/** RPC error code for a failed recipe create; `data` is RecipeWorkspaceCreateFailureData. */
export const RECIPE_WORKSPACE_CREATE_FAILED_CODE = 'recipe_workspace_create_failed' as const

export type RecipeWorkspaceCreateFailureData = {
  /** The step that failed. */
  phase: RecipeWorkspaceCreatePhase
  recipeId: string
  /** The recipe failure catalog code (see ephemeral-vm-failure-copy), when the recipe itself failed. */
  failureCode?: string
  failureParams?: Record<string, string | number>
  /** Present once a VM record exists. */
  runtimeId?: string
  /** What happened to a VM the failed create had started: destroyed, left for a manual retry, or
   *  left running because the recipe has no destroy step. */
  environment?: 'destroyed' | 'destroy-failed' | 'destroy-disabled'
  destroyError?: string
}

/** One repo's recipes as `orca vm recipe list` shows them. */
export type RecipeCatalogListing = {
  repoId: string
  repoName: string
  repoPath: string
  recipes: {
    id: string
    name: string
    description?: string
    checkoutMode: 'orca-worktree' | 'provisioned-root'
    /** Lifecycle steps the recipe defines besides create. */
    steps: ('suspend' | 'resume' | 'destroy')[]
    destroyDisabled: boolean
    timeoutSeconds?: Partial<Record<'create' | 'suspend' | 'resume' | 'destroy', number>>
  }[]
  /** orca.yaml problems that hid or changed a recipe. */
  diagnostics: { index: number; field?: string; message: string }[]
}
