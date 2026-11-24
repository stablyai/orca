export function branchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}
