import type { Repo } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'

// Estimate the pixel height of a virtualizer row based on which metadata lines
// will render.  All pixel constants are coupled to WorktreeCard's Tailwind
// classes (see the coupling comment in WorktreeCard's meta section).  The
// inter-card gap is handled by the virtualizer's `gap` option, not here.
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

  // Base: border(2) + py-2(16) + title leading-tight(15) + gap-1.5(6)
  //       + subtitle row with badges(16) = 55.
  // Why 55 not 52: the old value omitted the 2px border and used 14px for
  // the title instead of the actual 15px (12px × 1.25 leading-tight).
  // When both status and unread indicators are visible, the left column
  // (pt-[2px] + StatusIndicator h-3 + gap-2 + unread button size-4 = 38px)
  // is 1px taller than the content column (37px).
  let h = 55
  if (cardProps.includes('status') && cardProps.includes('unread')) {
    h += 1
  }

  // Count meta rows (issue, PR, comment) to add per-section spacing once.
  let metaCount = 0

  if (cardProps.includes('issue') && wt.linkedIssue) {
    h += 16 // py-0.5(4) + icon size-3(12)
    metaCount++
  }
  if (cardProps.includes('pr')) {
    const repo = repoMap.get(wt.repoId)
    const branch = wt.branch.replace(/^refs\/heads\//, '')
    const prKey = repo && branch ? `${repo.path}::${branch}` : ''
    if (prKey && prCache?.[prKey]?.data) {
      h += 16 // py-0.5(4) + icon size-3(12)
      metaCount++
    }
  }
  if (cardProps.includes('comment') && wt.comment) {
    // Comment is clamped to 2 lines (line-clamp-2) in the card. Full content
    // is shown in a hover card. Height: 2 lines × 16.5px + py-0.5(4px).
    h += Math.ceil(2 * 16.5) + 4
    metaCount++
  }

  if (metaCount > 0) {
    // Spacing before the meta section: parent flex gap-1.5(6) + mt-0.5(2).
    h += 8
    // gap-[3px] between sibling meta rows.
    h += (metaCount - 1) * 3
  }

  return h
}
