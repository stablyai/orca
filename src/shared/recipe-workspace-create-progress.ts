/** Named steps of creating a workspace on a fresh provider host, in the order they run. */
export const RECIPE_WORKSPACE_CREATE_PHASES = {
  'resolving-start-ref': 'Resolving the start ref',
  'running-create': "Running the provider's create step",
  'host-recorded': 'Recorded the new environment',
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

/** Host capability: `worktree.create` takes `target`, `provider.list` exists. Desktop only. */
export const WORKSPACE_PROVIDERS_RUNTIME_CAPABILITY = 'workspace.providers.v1' as const

/** RPC error code for a failed provider create; `data` is HostCreateFailureData. */
export const HOST_CREATE_FAILED_CODE = 'host_create_failed' as const

/** What a failed create left behind. `destroy-failed` and `left-running` mean a machine may still bill. */
export type CreatedHostState = 'destroyed' | 'destroy-failed' | 'left-running'

export type HostCreateFailureData = {
  /** The step that failed. */
  phase: RecipeWorkspaceCreatePhase
  /** Canonical target spelling, e.g. `recipe:dev-vm`. */
  target: string
  /** The provider's failure catalog code (see ephemeral-vm-failure-copy), when its step failed. */
  providerCode?: string
  providerParams?: Record<string, string | number>
  /** Present once the new host was recorded. */
  host?: { runtimeId: string; state: CreatedHostState }
  destroyError?: string
}

/** The JSON schema version `provider list` and provider creates print; bump only on a breaking change. */
export const WORKSPACE_PROVIDERS_SCHEMA_VERSION = 1 as const

/** One provider as `orca provider list --json` prints it. Fields are an allow-list. */
export type WorkspaceProviderListing = {
  /** Canonical `--on` value. */
  target: string
  kind: 'recipe' | 'plugin'
  name: string
  description?: string
  /** The repo whose orca.yaml or plugin set defines it. */
  repo: { id: string; name: string; path: string }
  available: boolean
  unavailableReason?: string
  checkoutMode: 'orca-worktree' | 'provisioned-root'
  capabilities: { suspend: boolean; resume: boolean; destroy: boolean }
  timeoutSeconds?: Partial<Record<'create' | 'suspend' | 'resume' | 'destroy', number>>
  /** Declared sizes and inputs; empty until providers declare them. */
  sizes: string[]
  inputs: { name: string; type: 'string'; required: boolean; description?: string }[]
}

export type WorkspaceProviderListResult = {
  schemaVersion: typeof WORKSPACE_PROVIDERS_SCHEMA_VERSION
  providers: WorkspaceProviderListing[]
  /** orca.yaml problems that hid or changed a recipe, per repo. */
  diagnostics: { repoId: string; index: number; field?: string; message: string }[]
}
