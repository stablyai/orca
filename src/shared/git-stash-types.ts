/**
 * Stash entries are a reflog projection over `refs/stash`, kept separate from
 * `git-status-types` (the working-tree porcelain projection) because the two
 * have disjoint lifecycles and consumers.
 */
export type GitStashEntry = {
  /** `stash@{N}` exactly as git printed it (`%gd`); the ref passed to apply/pop/drop. */
  ref: string
  /** Zero-based index parsed out of `ref`. */
  index: number
  /** Stash commit oid (`%H`). Guards against the index shifting under us. */
  commitOid: string
  /** Commit date (`%ct`), seconds since epoch. */
  createdAtSeconds: number
  /** Reflog subject (`%gs`), e.g. `WIP on main: 857f285 fix parser`. */
  subject: string
}

/**
 * Why: `git stash push` exits 0 with "No local changes to save" when there is
 * nothing to stash, so success alone can't tell the UI whether an entry was
 * created — `stashed` carries that.
 */
export type GitStashPushResult = { success: boolean; stashed: boolean; error?: string }

/**
 * Why: apply/pop conflicts are an expected outcome, not a transport failure —
 * git leaves the entry in place and exits non-zero, so `conflicted` lets the UI
 * explain that the stash survived instead of reporting a plain error.
 */
export type GitStashMutationResult = { success: boolean; error?: string; conflicted?: boolean }

export type GitStashPushOptions = { includeUntracked?: boolean; message?: string }

/** Identifies a stash entry plus the oid it had when the user picked it. */
export type GitStashTarget = { ref: string; expectedCommitOid?: string }
