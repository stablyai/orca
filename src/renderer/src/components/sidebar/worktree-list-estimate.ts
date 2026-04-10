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
    // Comment renders as markdown via react-markdown. Markdown block elements
    // (lists, code blocks, blockquotes) add some vertical overhead compared to
    // raw text, but the dominant factor is still line count. We estimate visual
    // lines from explicit newlines and character wrapping (~35 chars per line at
    // typical sidebar width), then add a small buffer for markdown block spacing.
    // Line-height is leading-normal (1.5 × 11px = 16.5px) + py-0.5(4px).
    const lines = wt.comment.split('\n')
    let totalLines = 0
    let hasBlocks = false
    let inCodeFence = false
    let codeFenceLines = 0
    for (const line of lines) {
      if (line.startsWith('```')) {
        hasBlocks = true
        if (inCodeFence) {
          // Closing fence: cap at max-h-32 (128px) ÷ 16.5 ≈ 8 visible lines
          totalLines += Math.min(codeFenceLines, 8)
          codeFenceLines = 0
        }
        inCodeFence = !inCodeFence
        continue
      }
      if (inCodeFence) {
        codeFenceLines++
      } else {
        totalLines += Math.max(1, Math.ceil(line.length / 35))
        // Detect markdown block elements that add extra vertical spacing.
        // Only check outside code fences — fenced content renders as plain code.
        if (/^(\s*[-*+]\s|#{1,6}\s|>\s|---|\d+\.\s)/.test(line)) {
          hasBlocks = true
        }
      }
    }
    // Handle unclosed code fence (treat remaining lines normally)
    if (inCodeFence) {
      totalLines += Math.min(codeFenceLines, 8)
    }
    h += Math.ceil(totalLines * 16.5) + 4
    // Markdown blocks (lists, headings, code fences) add ~4-8px of extra margin
    if (hasBlocks) {
      h += 8
    }
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
