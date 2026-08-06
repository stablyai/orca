import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'

type WorktreeCardReviewStatusProps = {
  review: WorktreeCardPrDisplay
}

function getReviewStatusTooltip(review: WorktreeCardPrDisplay): string {
  const label = getReviewLabel(review)
  if (review.state === 'merged') {
    return `${label}: Merged`
  }
  if (review.state === 'closed') {
    return `${label}: Closed`
  }
  if (review.state === 'draft') {
    return `${label}: Draft`
  }
  if (review.status === 'failure') {
    return `${label} checks: Failed`
  }
  if (review.status === 'pending') {
    return `${label} checks: Pending`
  }
  if (review.status === 'success') {
    return `${label} checks: Passing`
  }
  return `${label}: Open`
}

export function WorktreeCardReviewStatus({
  review
}: WorktreeCardReviewStatusProps): React.JSX.Element {
  const tooltip = getReviewStatusTooltip(review)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-worktree-card-review-status=""
          className="inline-flex size-5 shrink-0 items-center justify-center p-0.5"
        >
          <ReviewIcon review={review} className="size-[13px]" variant="generic" />
          <span className="sr-only">{tooltip}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{tooltip}</span>
      </TooltipContent>
    </Tooltip>
  )
}
