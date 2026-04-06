import type { Repo } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'

// Estimate the pixel height of a virtualizer row based on which metadata lines
// will render. Pixel constants (52, 22, 2, 4) are coupled to WorktreeCard's
// Tailwind classes — see the coupling comment in WorktreeCard's meta section.
//
// Uses prCache (not wt.linkedPR) because prCache is the actual data source
// WorktreeCard checks when deciding to show the PR row.
export function estimateRowHeight(
  row: Row,
  cardProps: string[],
  repoMap: Map<string, Repo>,
  prCache: Record<string, { data: unknown }> | null
): number {
  if (row.type === 'header') {
    return 42
  }
  const wt = row.worktree
  let h = 52 // base: py-2 + title + subtitle + gaps
  if (cardProps.includes('issue') && wt.linkedIssue) {
    h += 22
  }
  if (cardProps.includes('pr')) {
    const repo = repoMap.get(wt.repoId)
    const branch = wt.branch.replace(/^refs\/heads\//, '')
    const prKey = repo && branch ? `${repo.path}::${branch}` : ''
    if (prKey && prCache?.[prKey]?.data) {
      h += 22
    }
  }
  if (cardProps.includes('comment') && wt.comment) {
    h += 22
  }
  if (h > 52) {
    h += 2
  }
  return h + 4
}
