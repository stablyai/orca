/** Global opt-in: `off` (the default when unset) never writes repository config. */
export type GitTuningMode = 'recommended' | 'off'

export const GIT_PERFORMANCE_CONFIG_KEYS = [
  'core.untrackedCache',
  'core.fsmonitor',
  'index.version',
  'checkout.workers',
  'fetch.writeCommitGraph'
] as const

export type GitPerformanceConfigKey = (typeof GIT_PERFORMANCE_CONFIG_KEYS)[number]

export type GitPerformanceConfigAction = 'inspect' | 'apply' | 'revert'

export const GIT_PERFORMANCE_CONFIG_SKIP_REASONS = [
  'set-by-user',
  'set-by-feature-many-files',
  'git-version-unknown',
  'git-too-old',
  'platform',
  'filesystem',
  'fsmonitor-incompatible',
  'small-repository',
  'not-opted-in'
] as const

export type GitPerformanceConfigSkipReason = (typeof GIT_PERFORMANCE_CONFIG_SKIP_REASONS)[number]

export type GitPerformanceConfigEntry = { key: GitPerformanceConfigKey; value: string }

export type GitPerformanceConfigOptions = {
  /** `core.fsmonitor` is its own opt-in: Git < 2.36 on the same checkout misreads it. */
  fsmonitor?: boolean
  /** Revert only these keys; all of Orca's keys when absent. */
  keys?: GitPerformanceConfigKey[]
}

export type GitPerformanceConfigKeyPlan =
  | { key: GitPerformanceConfigKey; value: string; action: 'set' | 'keep' }
  | { key: GitPerformanceConfigKey; action: 'skip'; reason: GitPerformanceConfigSkipReason }

export type GitPerformanceConfigRepoState = {
  /** Keys whose repo-local value is still the one Orca wrote and recorded. */
  orcaKeys: GitPerformanceConfigEntry[]
  /** Keys set explicitly in any config scope without an Orca record. */
  userKeys: GitPerformanceConfigKey[]
}

/** Wire shape of the relay's `git.repoPerformanceConfig` reply; also the IPC payload. */
export type GitPerformanceConfigResult = {
  state: GitPerformanceConfigRepoState
  /** Present for `apply`: what happened to every key, including skips. */
  plan?: GitPerformanceConfigKeyPlan[]
  /** Present for `revert`: keys whose Orca-written value was removed. */
  reverted?: GitPerformanceConfigKey[]
}

export type GitPerformanceConfigUnavailableReason =
  | 'not-git'
  | 'not-found'
  | 'disabled'
  | 'ssh-disconnected'
  | 'relay-outdated'
  | 'failed'

export type RepoPerformanceConfigOutcome =
  | ({ status: 'ok' } & GitPerformanceConfigResult)
  | { status: 'unavailable'; reason: GitPerformanceConfigUnavailableReason; message?: string }

export function normalizeGitTuningMode(value: unknown): GitTuningMode {
  return value === 'recommended' ? 'recommended' : 'off'
}

export function isGitPerformanceConfigAction(value: unknown): value is GitPerformanceConfigAction {
  return value === 'inspect' || value === 'apply' || value === 'revert'
}

export function isGitPerformanceConfigKey(value: unknown): value is GitPerformanceConfigKey {
  return GIT_PERFORMANCE_CONFIG_KEYS.some((key) => key === value)
}
