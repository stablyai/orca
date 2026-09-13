import type { SelectedLineRange } from '@pierre/diffs'
import { canCommentOnRange } from '../../diff-comments/diff-comment-range'

export function canCommentOnPierreRange(
  range: SelectedLineRange,
  commentableLines: ReadonlySet<number> | null
): boolean {
  return (
    range.side !== 'deletions' &&
    range.endSide !== 'deletions' &&
    canCommentOnRange(range.start, range.end, commentableLines)
  )
}
