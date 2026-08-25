/**
 * Local-branch listing shared by every host that can answer it: the desktop
 * main process, the relay, and the SSH provider. Kept in one place so the argv
 * and the parser cannot drift between them — a mismatch would show different
 * branch sets depending on where the worktree lives.
 */

export type GitLocalBranchEntry = {
  name: string
  /**
   * Worktree holding this branch, when git reports one. Git refuses to check a
   * branch out twice, so the picker needs this to explain why a row is inert
   * instead of letting the checkout fail.
   */
  worktreePath?: string
}

export type GitLocalBranchListing = {
  current: string | null
  /** Short names, current branch first. */
  branches: string[]
  /**
   * Per-branch detail. Optional because a host older than this field still
   * answers `git.localBranches` with `current`/`branches` alone; callers must
   * degrade to "occupancy unknown" rather than assume the branch is free.
   */
  entries?: GitLocalBranchEntry[]
}

/**
 * `for-each-ref` rather than `branch`: scriptable output with no locale-dependent
 * decoration. `%(worktreepath)` is Git 2.23, under the 2.25 baseline, and is
 * empty for branches no worktree has checked out.
 */
export const LOCAL_BRANCH_LISTING_ARGV: readonly string[] = [
  'for-each-ref',
  '--format=%(HEAD)%09%(refname:short)%09%(worktreepath)',
  'refs/heads/'
]

export function parseLocalBranchListing(stdout: string): GitLocalBranchListing {
  let current: string | null = null
  const entries: GitLocalBranchEntry[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      continue
    }
    const [marker, name, worktreePath] = line.split('\t')
    if (!name) {
      continue
    }
    if (marker === '*') {
      current = name
    }
    entries.push(worktreePath ? { name, worktreePath } : { name })
  }
  // Why: surface the checked-out branch first so the picker reads "you are here"
  // at the top, then the rest in git's ref order.
  entries.sort((a, b) => {
    if (a.name === current) {
      return -1
    }
    if (b.name === current) {
      return 1
    }
    return 0
  })
  return { current, branches: entries.map((entry) => entry.name), entries }
}
