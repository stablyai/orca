/** Corruption guard, not a product limit — a worktree fanning out to more
 *  destinations than this is conceivable, but a persisted list longer than it
 *  is damaged data. */
const MAX_TRACKED_BRANCHES = 20
const MAX_BRANCH_LENGTH = 250

/** Characters git itself rejects in ref names (check-ref-format). */
const INVALID_BRANCH_CHARS = /[ ~^:?*[\\]/

/**
 * Normalizes the persisted tracked-branch list.
 *
 * Tracked branches are sibling head branches (e.g. `task/X-v1.15.0`,
 * `task/X-stage`) whose reviews the worktree card should surface alongside the
 * one detected from the worktree's own branch. Entries are branch names, not
 * refs: `refs/heads/` is stripped so CLI and UI input converge on the same key
 * the hosted-review cache uses.
 *
 * Anything unusable is dropped rather than repaired — a name git would reject
 * can never resolve to a review, so a partial entry would only render a dead
 * row.
 */
export function normalizeTrackedBranches(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const out: string[] = []
  const seen = new Set<string>()

  for (const raw of value.slice(0, MAX_TRACKED_BRANCHES)) {
    if (typeof raw !== 'string') {
      continue
    }
    const branch = raw.trim().replace(/^refs\/heads\//, '')
    if (!isUsableBranchName(branch)) {
      continue
    }
    if (seen.has(branch)) {
      continue
    }
    seen.add(branch)
    out.push(branch)
  }

  return out
}

/** Adds a branch to the list; re-adding an existing one is a no-op. */
export function addTrackedBranch(current: readonly string[] | undefined, branch: string): string[] {
  return normalizeTrackedBranches([...(current ?? []), branch])
}

/** Removes a branch from the list, matching by normalized name. */
export function removeTrackedBranch(
  current: readonly string[] | undefined,
  branch: string
): string[] {
  const [target] = normalizeTrackedBranches([branch])
  if (target === undefined) {
    return normalizeTrackedBranches(current ?? [])
  }
  return normalizeTrackedBranches((current ?? []).filter((item) => item.trim() !== target))
}

function isUsableBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > MAX_BRANCH_LENGTH) {
    return false
  }
  if (INVALID_BRANCH_CHARS.test(branch) || branch.includes('..') || branch.includes('@{')) {
    return false
  }
  for (let i = 0; i < branch.length; i++) {
    const code = branch.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }
  return (
    branch !== '/' && !branch.startsWith('/') && !branch.endsWith('/') && !branch.endsWith('.lock')
  )
}
