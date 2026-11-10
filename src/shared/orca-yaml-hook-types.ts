export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupAgentStartupPolicy = 'start-immediately' | 'wait-for-setup'
export type HookCommandSourcePolicy = 'shared-only' | 'local-only' | 'run-both'

export type OrcaHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
    run?: OrcaRunAction[] // Named run actions (dev servers, watchers), started from the Run button
    runMode?: OrcaRunMode // Default for every action; an action's own runMode wins
    // true runs the default action once setup succeeds; a string names the action to run.
    autoRunAfterSetup?: boolean | string
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

/**
 * `concurrent`: the action may run in several workspaces at once.
 * `nonconcurrent`: starting it first stops every other running action of the same project,
 * for projects that share one fixed port, database or container stack.
 */
export type OrcaRunMode = 'concurrent' | 'nonconcurrent'

/** Where an action is offered: `local` checkouts, or `remote` hosts (SSH and runtime servers). */
export type OrcaRunActionHost = 'local' | 'remote'

export type OrcaRunAction = {
  id: string
  /** Shown on the Run button; defaults to the id with hyphens shown as spaces. */
  name: string
  command: string
  /** Relative to the workspace root. */
  cwd?: string
  env?: Record<string, string>
  default?: boolean
  runMode?: OrcaRunMode
  /** Omitted means every host. */
  availableIn?: OrcaRunActionHost[]
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
  /** Built-in providers run in-process; the lifecycle strings are labels, never executed. */
  provider?: OrcaVmRecipeProviderId
}

export type OrcaVmRecipeProviderId = 'orca-cloud'

/**
 * Whether this build and account can use Orca Cloud: `offered` adds its recipe; `needs-sign-in` and
 * `needs-capability` let the picker show a sign-in or upsell row; `unavailable` hides it entirely.
 */
export type OrcaCloudAvailability = 'offered' | 'needs-sign-in' | 'needs-capability' | 'unavailable'

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
    /** This machine's own run actions (e.g. imported); an id here replaces the orca.yaml one. */
    run?: OrcaRunAction[]
    runMode?: OrcaRunMode
    autoRunAfterSetup?: boolean | string
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
  run?: PersistedTrustedOrcaHookEntry
}

export type PersistedTrustedOrcaHooks = Record<string, PersistedTrustedOrcaHookRepo>
