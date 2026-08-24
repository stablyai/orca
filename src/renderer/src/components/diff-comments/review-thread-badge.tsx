import { MessageSquareDiff } from 'lucide-react'
import { reviewThreadBadgeTitle } from './review-thread-copy'

/** Per-file PR review-thread count shown on file rows; diff-marked bubble keeps it distinct from the plain local-notes badge. */
export function ReviewThreadBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) {
    return null
  }
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
      title={reviewThreadBadgeTitle(count)}
    >
      <MessageSquareDiff className="size-3" />
      <span className="tabular-nums">{count}</span>
    </span>
  )
}
