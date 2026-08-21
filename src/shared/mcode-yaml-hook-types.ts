export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupAgentStartupPolicy = 'start-immediately' | 'wait-for-setup'
export type HookCommandSourcePolicy = 'shared-only' | 'local-only' | 'run-both'

// ─── Hooks (mcode.yaml) ──────────────────────────────────────────────
export type MCodeHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
  issueCommand?: string // Shared default command for linked GitHub issues
  defaultTabs?: MCodeDefaultTabTemplate[] // Terminal tabs to create once for a new worktree
  environmentRecipes?: MCodeVmRecipe[] // Project-scoped per-workspace environment recipes
  environmentRecipeDiagnostics?: MCodeVmRecipeDiagnostic[] // Non-fatal validation issues from environmentRecipes
  worktree?: MCodeWorktreeDefaults // Project-scoped defaults applied when a worktree is created
}

export type MCodeWorktreeDefaults = {
  // Why: shared (symlinked) rather than copied — large rebuildable dirs like
  // node_modules should be one install serving every worktree.
  sharedDirectories?: string[]
}

export type MCodeDefaultTabTemplate = {
  title?: string
  color?: string
  command?: string
}

export type EphemeralVmCheckoutMode = 'mcode-worktree' | 'provisioned-root'

export type MCodeVmRecipe = {
  id: string
  name: string
  create: string
  checkoutMode?: EphemeralVmCheckoutMode
  description?: string
  suspend?: string
  resume?: string
  destroy?: string
  destroyDisabled?: boolean
}

export type MCodeVmRecipeDiagnostic = {
  index: number
  field?: string
  message: string
}

export type RepoHookSettings = {
  // Why: persisted data may still include the old mode field from the earlier
  // hook UI. Keep it in the shape so existing local state reads without a migration.
  mode: 'auto' | 'override'
  setupRunPolicy?: SetupRunPolicy
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  commandSourcePolicy?: HookCommandSourcePolicy
  scripts: {
    setup: string
    archive: string
  }
}

export type PersistedTrustedMCodeHookEntry = {
  contentHash: string
  approvedAt: number
}

export type PersistedTrustedMCodeHookRepo = {
  all?: {
    approvedAt: number
  }
  setup?: PersistedTrustedMCodeHookEntry
  archive?: PersistedTrustedMCodeHookEntry
  issueCommand?: PersistedTrustedMCodeHookEntry
  vmRecipe?: PersistedTrustedMCodeHookEntry
}

export type PersistedTrustedMCodeHooks = Record<string, PersistedTrustedMCodeHookRepo>
