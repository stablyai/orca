import type { Repo } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'

// Estimate the pixel height of a virtualizer row based on which metadata lines
// will render. Fixed-height rows (base 52, issue/PR 22, mt-0.5 2) are coupled
// to WorktreeCard's Tailwind classes; the comment row uses a dynamic estimate
// because it renders with whitespace-pre-wrap.  See the coupling comment in
// WorktreeCard's meta section.  The inter-card gap is handled by the
// virtualizer's `gap` option, not here.
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
    return 38
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
    // Comment now renders with whitespace-pre-wrap + break-words, so its
    // height depends on content.  Estimate visual lines from explicit newlines
    // and character wrapping (~35 chars per line at typical sidebar width).
    // Line-height is leading-normal (1.5 × 11px = 16.5px) + 4px padding (py-0.5).
    const lines = wt.comment.split('\n')
    let totalLines = 0
    for (const line of lines) {
      totalLines += Math.max(1, Math.ceil(line.length / 35))
    }
    h += Math.ceil(totalLines * 16.5) + 4
  }
  if (h > 52) {
    h += 2
  }
  return h
}
