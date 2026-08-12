/**
 * Shared refs/stash has no worktree ownership (Git docs: refs/* are shared except
 * bisect/worktree/rewritten). Orca only has the branch name recorded in the subject
 * at stash time — use it to keep deletion preflight from orphaning stashed WIP.
 */

/** Prefix of the user-facing removal error when branch-attributed stash blocks delete. */
export const WORKTREE_STASH_REMOVAL_ERROR =
  'Worktree has uncommitted or untracked changes.'

/** Detail prefix so force-delete classification and UI copy can recognize stash blocks. */
export const WORKTREE_STASH_REMOVAL_DETAIL_PREFIX =
  'Shared git stash still holds'

/**
 * Branch name recorded in a `git stash list --format=%gs` subject, or null when
 * the subject is not the standard `On <branch>:` / `WIP on <branch>:` form.
 */
export function branchFromStashSubject(subject: string): string | null {
  const match = /^(?:WIP on|On) (.+?): /.exec(subject.trim())
  if (!match) {
    return null
  }
  const branch = match[1]?.trim()
  if (!branch || branch === '(no branch)') {
    return null
  }
  return branch
}

/** True when a stash subject was recorded while `branch` was checked out. */
export function stashSubjectMatchesBranch(subject: string, branch: string): boolean {
  const recorded = branchFromStashSubject(subject)
  return recorded !== null && recorded === branch
}

/**
 * Count stash subjects that Git recorded on `branch`. Subjects are `%gs` lines
 * from `git stash list --format=%gs` (no positional stash@{N} — concurrent pushes
 * shift indices but not these subject strings).
 */
export function countStashSubjectsForBranch(
  subjects: readonly string[],
  branch: string
): number {
  if (!branch) {
    return 0
  }
  let count = 0
  for (const subject of subjects) {
    if (stashSubjectMatchesBranch(subject, branch)) {
      count += 1
    }
  }
  return count
}

export function formatWorktreeStashRemovalDetail(count: number, branch: string): string {
  const entryWord = count === 1 ? 'entry' : 'entries'
  return (
    `${WORKTREE_STASH_REMOVAL_DETAIL_PREFIX} ${count} ${entryWord} recorded on branch ${branch}. ` +
    'refs/stash is shared across every worktree of this repository with no worktree ownership; ' +
    'recover or drop those entries before deleting, or force-delete to leave them behind.'
  )
}

/** Split `git stash list --format=%gs` stdout into subject lines (LF or CRLF). */
export function parseStashListSubjects(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
