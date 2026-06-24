// Why: the director's log records the *local* branch (`chore/gtm-e2e-ci`), but
// the merged PR's head ref is the *pushed* name (`zaridan/chore-gtm-e2e-ci` — a
// configured prefix + slashes→dashes). Rather than reconstruct the prefix (which
// depends on git-username resolution), match prefix-agnostically: the pushed head
// ends with the local branch as a path segment, with slashes turned to dashes.
export function matchesShippedBranch(headRefName: string, localBranch: string): boolean {
  if (!headRefName || !localBranch) {
    return false
  }
  const dashed = localBranch.replace(/\//g, '-')
  return headRefName === localBranch || headRefName === dashed || headRefName.endsWith(`/${dashed}`)
}
