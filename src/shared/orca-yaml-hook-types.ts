export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupAgentStartupPolicy = 'start-immediately' | 'wait-for-setup'
export type HookCommandSourcePolicy = 'shared-only' | 'local-only' | 'run-both'

export type OrcaHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  issueCommand?: string // Shared default command for linked GitHub issues
  defaultTabs?: OrcaDefaultTabTemplate[] // Terminal tabs to create once for a new worktree
  environmentRecipes?: OrcaVmRecipe[] // Project-scoped per-workspace environment recipes
  environmentRecipeDiagnostics?: OrcaVmRecipeDiagnostic[] // Non-fatal validation issues from environmentRecipes
  worktree?: OrcaWorktreeDefaults // Project-scoped defaults applied when a worktree is created
}

export type OrcaWorktreeDefaults = {
  // Share large rebuildable directories such as node_modules across worktrees instead of copying installs.
  sharedDirectories?: string[]
}

export type OrcaDefaultTabTemplate = {
  title?: string
  color?: string
  command?: string
}

export type EphemeralVmCheckoutMode = 'orca-worktree' | 'provisioned-root'

export type OrcaVmRecipe = {
  id: string
  name: string
  create: string
  checkoutMode?: EphemeralVmCheckoutMode
  description?: string
  suspend?: string
  resume?: string
  destroy?: string
  destroyDisabled?: boolean
  // Per-mode wall-clock limits; orca.yaml accepts one number for every mode or a per-mode map.
  timeoutSeconds?: OrcaVmRecipeTimeoutSeconds
  // Opt-in allowlist of Orca's environment variables the scripts receive (plus a safe base set).
  // Omitted means scripts inherit the full environment.
  passEnv?: string[]
}

export type OrcaVmRecipeLifecycleMode = 'create' | 'suspend' | 'resume' | 'destroy'

export type OrcaVmRecipeTimeoutSeconds = Partial<Record<OrcaVmRecipeLifecycleMode, number>>

export type OrcaVmRecipeDiagnostic = {
  index: number
  field?: string
  message: string
}

export type RepoHookSettings = {
  // Retain the old hook-UI mode so persisted state reads without migration.
  mode: 'auto' | 'override'
  setupRunPolicy?: SetupRunPolicy
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  commandSourcePolicy?: HookCommandSourcePolicy
  scripts: {
    setup: string
    archive: string
  }
}

export type PersistedTrustedOrcaHookEntry = {
  contentHash: string
  approvedAt: number
  /** Earlier approvals, newest first, so switching between branches' scripts doesn't re-prompt. */
  previousContentHashes?: string[]
}

export type PersistedTrustedOrcaHookRepo = {
  all?: {
    approvedAt: number
  }
  setup?: PersistedTrustedOrcaHookEntry
  archive?: PersistedTrustedOrcaHookEntry
  issueCommand?: PersistedTrustedOrcaHookEntry
  vmRecipe?: PersistedTrustedOrcaHookEntry
}

export type PersistedTrustedOrcaHooks = Record<string, PersistedTrustedOrcaHookRepo>
