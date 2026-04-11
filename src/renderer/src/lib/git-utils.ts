/** Strip the `refs/heads/` prefix from a branch ref to get the display name. */
export function branchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}
