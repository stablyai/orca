import type { GitUpstreamStatus } from './git-status-types'

/** One initialized submodule of a worktree, listed as its own repository. */
export type GitSubmoduleRepo = {
  /** Path relative to the parent worktree, with forward slashes. */
  path: string
  /** Checked-out branch; null when HEAD is detached. */
  branch: string | null
  /** Ahead/behind of the branch; null when it cannot be read. */
  upstream: Pick<GitUpstreamStatus, 'hasUpstream' | 'upstreamName' | 'ahead' | 'behind'> | null
}
