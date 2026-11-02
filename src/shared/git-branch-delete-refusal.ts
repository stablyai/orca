import { readGitCommandFailureText } from './git-command-failure-text'

/** Git through 2.40 says checked out at; 2.43+ says used by worktree at. Both arrive on stderr.
 * A match permits pruning stale worktree metadata and retrying deletion once. */
export function isBranchCheckedOutInWorktreeError(error: unknown): boolean {
  return /cannot delete branch .*(?:used by worktree|checked out)|branch .*is checked out/i.test(
    readGitCommandFailureText(error)
  )
}
