import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'

export type WorktreeLocationMode = 'sibling' | 'nested'

export const DEFAULT_WORKTREE_LOCATION_MODE: WorktreeLocationMode = 'sibling'

/**
 * Resolve the effective worktree-location mode for a repo: the repo's explicit
 * choice wins, otherwise the global default, otherwise the built-in default.
 */
export function resolveWorktreeLocationMode(
  repo: Pick<Repo, 'worktreeLocationMode'>,
  settings: Partial<Pick<GlobalSettings, 'defaultWorktreeLocationMode'>>
): WorktreeLocationMode {
  return (
    repo.worktreeLocationMode ??
    settings.defaultWorktreeLocationMode ??
    DEFAULT_WORKTREE_LOCATION_MODE
  )
}

/** True when the repo's effective mode places worktrees in nested `.worktrees/`. */
export function isNestedWorktreeLocation(
  repo: Pick<Repo, 'worktreeLocationMode'>,
  settings: Partial<Pick<GlobalSettings, 'defaultWorktreeLocationMode'>>
): boolean {
  return resolveWorktreeLocationMode(repo, settings) === 'nested'
}
