/** How local branch names relate to ngit pull requests, on both sides of the RPC. */

// `pr/name(1a2b3c4d)` is ngit's checkout; `name-1a2b3c4d` a workspace Orca started from the pull
// request, whatever branch prefix it got.
const BRANCH_ID_SUFFIX = /(?:\(([0-9a-f]{8})\)|-([0-9a-f]{8}))$/
const DEFAULT_BRANCH_NAMES = new Set(['main', 'master'])

export function ngitShortBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function isNgitDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCH_NAMES.has(ngitShortBranch(branch))
}

export function ngitBranchIdPrefix(branch: string): string | undefined {
  const suffix = ngitShortBranch(branch).match(BRANCH_ID_SUFFIX)
  return suffix?.[1] ?? suffix?.[2]
}

/** A branch or `branch-name` tag without ngit's `pr/` prefix. */
export function ngitProposalName(branch: string): string {
  return ngitShortBranch(branch).replace(/^pr\//, '')
}
