import type { GitBranchCompareSummary } from '../../../../../../shared/git-diff-compare-types'

export function getKnownGitHead(head: string | null | undefined): string | undefined {
  const trimmed = head?.trim()
  return trimmed ? trimmed : undefined
}

export function createLoadingBranchCompareSummary(baseRef: string): GitBranchCompareSummary {
  return {
    baseRef,
    baseOid: null,
    compareRef: 'HEAD',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'loading'
  }
}

export function branchCompareMatchesStatusHead(
  summary: GitBranchCompareSummary,
  statusHead: string
): boolean {
  const summaryHead = getKnownGitHead(summary.headOid)
  // Why: git status reports '(initial)' for unborn branches; branch compare represents that same state as a null headOid.
  return summaryHead === statusHead || (statusHead === '(initial)' && summary.headOid === null)
}
