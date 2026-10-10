/**
 * A folder inside one of Orca's worktree roots that no project registers as a worktree.
 *
 * Why its own shape and not a `WorkspaceCleanupCandidate`: it has no repo, branch, git status or
 * workspace id, and every candidate consumer (removal, dismissal, snapshot prune) assumes those.
 * Keeping it out of `candidates` means an older client that ignores this optional list can never
 * route a stray folder into `worktrees:remove`.
 */
export type WorkspaceCleanupStrayDirectory = {
  path: string
  /** The worktree root the folder was found in. */
  rootPath: string
  /** Project folder name under a nested root; absent for a flat root. */
  containerName?: string
  /** Projects whose worktree root holds this folder. */
  repoIds: string[]
  lastModifiedAt: number
  /** `missing-gitdir`: a `.git` file that points at a Git folder that no longer exists. */
  gitLink: 'none' | 'missing-gitdir'
  reasons: ['unregistered']
  /** Never ready: a folder Git does not know about has no evidence that nothing is lost. */
  tier: 'review'
  selectedByDefault: false
}

/** Why a worktree root was not read; reported so the UI never implies a root was checked. */
export type WorkspaceCleanupStrayDirectorySkipReason =
  | 'remote-host'
  | 'wsl'
  | 'holds-projects'
  | 'unreadable'

export type WorkspaceCleanupStrayDirectoryScan = {
  directories: WorkspaceCleanupStrayDirectory[]
  skippedRoots: { reason: WorkspaceCleanupStrayDirectorySkipReason; count: number }[]
  /** True when more folders matched than the scan reports. */
  truncated: boolean
}

export type WorkspaceCleanupTrashStrayDirectoryArgs = {
  path: string
}

export type WorkspaceCleanupTrashStrayDirectoryResult =
  | { ok: true }
  | { ok: false; message: string }

/** A folder touched within this window may be a checkout still being created or copied. */
export const WORKSPACE_CLEANUP_STRAY_DIRECTORY_MIN_AGE_MS = 24 * 60 * 60 * 1000
export const WORKSPACE_CLEANUP_STRAY_DIRECTORY_LIMIT = 200
