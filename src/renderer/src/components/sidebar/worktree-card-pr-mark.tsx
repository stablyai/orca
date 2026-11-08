import React from 'react'
import { GitBranch } from 'lucide-react'
import { FolderIcon } from '@/components/FileTypeIcon'
import type { WorktreeCardController } from './workspace-card/controller/use-worktree-card-controller'
import type { WorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-display'
import { getReviewLabel, ReviewIcon } from './workspace-card/review/worktree-review-presentation'

/** Open the workspace's own review: in Orca for GitHub, else the browser, else the details card. */
export function openWorktreeCardOwnReview(
  card: WorktreeCardController,
  event: React.MouseEvent
): void {
  const review = card.statusLaneReview
  if (review?.provider === 'github' && card.repo && review.url) {
    card.handleOpenReviewInOrca(event, review)
  } else if (review?.url) {
    event.stopPropagation()
    card.handleOpenReviewInBrowser(review.url)
  } else {
    event.stopPropagation()
    card.detailsHoverControl.handleHoverOpenChange(true)
  }
}

/** PR icon style: the workspace's own review state, as the 1.0 card's status lane draws it. */
export function WorktreeCardPrMark({
  review,
  hasBranch,
  onOpen,
  onPointerDown
}: {
  review: WorktreeCardPrDisplay | null
  hasBranch: boolean
  onOpen: (event: React.MouseEvent) => void
  onPointerDown: React.PointerEventHandler
}): React.JSX.Element {
  if (!review) {
    return (
      <span className="worktree-card-leading-mark" aria-hidden>
        {hasBranch ? (
          <GitBranch className="size-[13px] text-muted-foreground/70" />
        ) : (
          <FolderIcon open={false} className="size-[13px] text-muted-foreground" />
        )}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="worktree-card-leading-mark worktree-card-leading-mark-button"
      aria-label={getReviewLabel(review)}
      title={getReviewLabel(review)}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(event)
      }}
    >
      <ReviewIcon review={review} className="size-[13px]" variant="generic" />
    </button>
  )
}
