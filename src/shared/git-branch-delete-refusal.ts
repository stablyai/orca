import { readGitCommandFailureText } from './git-command-failure-text'

/**
 * `git branch -d/-D` refused because the branch is the HEAD of some worktree.
 *
 * Both wordings are live in Orca's supported range: Git through 2.40 says
 * "Cannot delete branch 'x' checked out at '<path>'", and 2.43+ says "cannot delete
 * branch 'x' used by worktree at '<path>'". Every version prints it through `error()`,
 * so it arrives on stderr. Callers treat a match as "the blocker may be a stale
 * worktree record", prune, and retry once.
 */
export function isBranchCheckedOutInWorktreeError(error: unknown): boolean {
  return /cannot delete branch .*(?:used by worktree|checked out)|branch .*is checked out/i.test(
    readGitCommandFailureText(error)
  )
}
