/**
 * Shared refs/stash has no worktree attribution (Git: refs/* are shared except
 * bisect/worktree/rewritten). Stash subjects only record the branch name at
 * stash time — that is branch attribution, not ownership or origin. A subject
 * matching the worktree's branch may have been created in another worktree
 * that used the same branch name earlier.
 */

/** Distinct from the dirty-tree message so force UI and recovery copy stay accurate. */
export const WORKTREE_STASH_REMOVAL_ERROR =
  'Worktree has shared stash entries recorded on its branch.'

/** Fail-closed when a known branch's stash list cannot be read before non-force delete. */
export const WORKTREE_STASH_VERIFICATION_ERROR =
  'Could not verify shared git stash safety for this worktree.'

export const WORKTREE_STASH_REMOVAL_DETAIL_PREFIX =
  'Shared git stash still holds'

/**
 * Branch name recorded in a `git stash list --format=%gs` subject, or null when
 * the subject is not the standard `On <branch>:` / `WIP on <branch>:` form.
 * Detached subjects (`(no branch)`) yield null — no inventable attribution.
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
 * Count stash subjects Git recorded on `branch`. Subjects are `%gs` lines from
 * `git stash list --format=%gs` (not positional `stash@{N}` — concurrent pushes
 * shift indices but not these strings).
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

/**
 * User-facing detail for a branch-attributed stash block.
 * Does not claim the entry originated in this worktree; force leaves entries intact.
 */
export function formatWorktreeStashRemovalDetail(count: number, branch: string): string {
  const entryWord = count === 1 ? 'entry' : 'entries'
  return (
    `${WORKTREE_STASH_REMOVAL_DETAIL_PREFIX} ${count} ${entryWord} whose subject was recorded on branch ${branch}. ` +
    'refs/stash is shared across every worktree of this repository; subject branch is attribution only and may come from another worktree that used the same branch. ' +
    'Recover those entries (for example pop/apply into the right checkout) before deleting, or force-delete to leave the shared stack unchanged.'
  )
}

export function formatWorktreeStashVerificationDetail(branch: string): string {
  return (
    `${WORKTREE_STASH_VERIFICATION_ERROR} ` +
    `Branch ${branch} is known, but listing refs/stash failed. Retry when Git is healthy, or force-delete to bypass this check (shared stash entries stay intact).`
  )
}

/** Split `git stash list --format=%gs` stdout into subject lines (LF or CRLF). */
export function parseStashListSubjects(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
