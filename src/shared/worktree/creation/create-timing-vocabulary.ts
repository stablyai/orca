/** Closed telemetry phases; never derive these from branch names, refs or paths. */
export const WORKTREE_CREATE_PHASES = [
  'resolve_name',
  'refresh_base_ref',
  'git_worktree_add',
  /** Includes base probe and drift check. */
  'prepared_checkout_claim',
  'prepared_checkout_wait',
  'prepared_checkout_finalize',
  'prepared_checkout_discard',
  'list_created_worktree',
  'persist_metadata',
  'create_symlinks',
  'resolve_shared_directories',
  'resolve_worktreeinclude',
  'create_shared_directories',
  'copy_worktreeinclude',
  'prepare_setup',
  'spawn_startup_terminal'
] as const

export type WorktreeCreatePhase = (typeof WORKTREE_CREATE_PHASES)[number]

/** Closed telemetry reasons; never derive these from branch names, refs or paths. */
export const PREPARED_CHECKOUT_MISS_REASONS = [
  'none_armed',
  /** Other repos have preparations; distinguish an unwarmed/evicted repo from an empty pool to expose multi-project cap thrashing. */
  'repo_mismatch',
  'base_mismatch',
  'retarget_too_divergent',
  /** No drift verdict: deadline, cancellation or Git failure. Distinguish skipped verification from a proven divergence; this bucket alone does not prove a small budget. */
  'retarget_unverifiable',
  'workspace_root_mismatch',
  'wsl_distro_mismatch',
  'prepare_failed',
  'finalize_failed',
  'checkout_existing_branch',
  'sparse_checkout'
] as const

export type PreparedCheckoutMissReason = (typeof PREPARED_CHECKOUT_MISS_REASONS)[number]

export const PREPARED_CHECKOUT_RESETS = ['none', 'base_moved', 'retargeted'] as const

export type PreparedCheckoutReset = (typeof PREPARED_CHECKOUT_RESETS)[number]

/** Attribute a hit to prefetch, automatic burst replacement, or a replacement later requested by prefetch. */
export const PREPARED_CHECKOUT_ORIGINS = ['prefetch', 'rearm', 'rearm_then_prefetch'] as const

export type PreparedCheckoutOrigin = (typeof PREPARED_CHECKOUT_ORIGINS)[number]

export const WORKTREE_CREATE_EXECUTION_HOSTS = ['local', 'wsl', 'ssh'] as const

export type WorktreeCreateExecutionHost = (typeof WORKTREE_CREATE_EXECUTION_HOSTS)[number]

/** Runtime includes CLI, agents, mobile, paired clients and orchestration. */
export const WORKSPACE_CREATE_ENTRY_POINTS = ['app', 'runtime'] as const

export type WorkspaceCreateEntryPoint = (typeof WORKSPACE_CREATE_ENTRY_POINTS)[number]
