/** A worktree provider definition from the user config or a repo's orca.yaml. */
export const WORKTREE_PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const WORKTREE_PROVIDER_NAME_RULE =
  'Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, starting with a letter or number.'
export const DEFAULT_WORKTREE_PROVIDER_TIMEOUT_SECONDS = 300
export const MAX_WORKTREE_PROVIDER_TIMEOUT_SECONDS = 3600
export const MAX_WORKTREE_PROVIDER_ARGV_LENGTH = 64
export const MAX_WORKTREE_PROVIDER_ARG_LENGTH = 4096
export const MAX_WORKTREE_PROVIDER_HANDLE_JSON_LENGTH = 32_768
export const MAX_WORKTREE_PROVIDER_STDOUT_BYTES = 1024 * 1024
export const MAX_WORKTREE_PROVIDER_CONFIG_COUNT = 32

export type WorktreeProviderCommand = readonly string[]
export type WorktreeProviderWorkingDirectory = 'repo' | 'worktree'
export type WorktreeProviderSource = 'user' | 'repo'

export type WorktreeProviderConfig = {
  claim: WorktreeProviderCommand
  release: WorktreeProviderCommand
  status?: WorktreeProviderCommand
  setup?: WorktreeProviderCommand
  timeoutSeconds?: number
  workingDirectory?: WorktreeProviderWorkingDirectory
}

/** A validated provider with defaults applied. */
export type ResolvedWorktreeProvider = WorktreeProviderConfig & {
  name: string
  source: WorktreeProviderSource
  timeoutSeconds: number
  workingDirectory: WorktreeProviderWorkingDirectory
  configHash: string
}

/** The durable lease recorded on a provider-managed WorktreeMeta. */
export type WorktreeProviderWorkspace = {
  name: string
  profile?: string
  leaseId?: string
  /** Opaque JSON the provider wants back on release. Never assume it is secret-free when logging. */
  handle?: Record<string, unknown>
  /** The provider's own path spelling; the workspace row uses Git's canonical path. */
  providerPath?: string
  timeoutSeconds: number
  acquiredAt: number
  configHash?: string
}

/** Claim stdout: exactly one JSON object. */
export type WorktreeProviderClaimResponse = {
  path: string
  leaseId?: string
  profile?: string
  handle?: Record<string, unknown>
}

export type WorktreeProviderDiagnostic = {
  source: WorktreeProviderSource
  path: string
  provider?: string
  message: string
}

/** Stable RPC error codes so CLI/desktop callers can act without parsing prose. */
export const WORKTREE_PROVIDER_ERROR_CODES = [
  'worktree_provider_managed',
  'worktree_provider_not_managed',
  'worktree_provider_not_local',
  'worktree_provider_not_configured',
  'worktree_provider_config_conflict',
  'worktree_provider_untrusted',
  'worktree_provider_config_missing',
  'worktree_provider_config_changed',
  'worktree_provider_claim_failed',
  'worktree_provider_claim_timeout',
  'worktree_provider_claim_invalid',
  'worktree_provider_setup_failed',
  'worktree_provider_path_conflict',
  'worktree_provider_path_invalid',
  'worktree_provider_command_failed',
  'worktree_provider_release_refused',
  'worktree_provider_release_failed'
] as const
