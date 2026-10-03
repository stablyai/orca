import type {
  CustomWorktreeVisibilitySource,
  ExternalWorktreeVisibility,
  WorktreeVisibilitySourcePreferences
} from '../repo-types'

/** Host-owned worktree visibility defaults, used when a repository has no explicit override. */
export type WorktreeVisibilityDefaults = {
  /** Default for worktrees outside a recognized source. */
  external?: ExternalWorktreeVisibility
  /** Host-owned roots applied to every repository on that host. */
  customSources?: CustomWorktreeVisibilitySource[]
  /** Defaults for built-in and host-owned custom sources. */
  sourcePreferences?: WorktreeVisibilitySourcePreferences
}
