import React from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Copy, Ellipsis, ExternalLink, MonitorUp, Unlink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader, MetadataActionIcon } from './WorktreeCardMetadataControls'
import { ReviewChecksBadge, ReviewStateBadge } from './WorktreeCardMetadataStatusBadges'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getProviderName, getReviewLabel, ReviewIcon } from './worktree-review-helpers'

type WorktreeCardReviewDetailSectionProps = {
  review: WorktreeCardPrDisplay | null
  reviewMenuOpen: boolean
  onReviewMenuOpenChange: (open: boolean) => void
  onOpenReviewInOrca?: (event: React.MouseEvent) => void
  onCopyReviewLink?: () => void
  onUnlinkReview?: () => void
  closeHover: () => void
}

export function WorktreeCardReviewDetailSection({
  review,
  reviewMenuOpen,
  onReviewMenuOpenChange,
  onOpenReviewInOrca,
  onCopyReviewLink,
  onUnlinkReview,
  closeHover
}: WorktreeCardReviewDetailSectionProps): React.JSX.Element | null {
  if (!review) {
    return null
  }

  const reviewLabel = getReviewLabel(review)
  const reviewProvider = getProviderName(review)
  const moreActionsLabel = translate(
    'auto.components.sidebar.WorktreeCardMeta.dbe2d18972',
    'More {{value0}} actions',
    { value0: reviewLabel }
  )
  const moreActionsTrigger = (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-6"
        aria-label={moreActionsLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <Ellipsis className="size-3" />
      </Button>
    </DropdownMenuTrigger>
  )
  const dismissAndOpenReview = (event: React.MouseEvent): void => {
    closeHover()
    onOpenReviewInOrca?.(event)
  }

  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<ReviewIcon review={review} className="size-3" />}
        label={translate(
          'auto.components.sidebar.WorktreeCardReviewDetailSection.reviewHeader',
          '{{value0}} #{{value1}}',
          { value0: reviewLabel, value1: review.number }
        )}
        actions={
          <>
            {(onCopyReviewLink || onUnlinkReview) && (
              <DropdownMenu
                modal={false}
                open={reviewMenuOpen}
                onOpenChange={onReviewMenuOpenChange}
              >
                {reviewMenuOpen ? (
                  moreActionsTrigger
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>{moreActionsTrigger}</TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {moreActionsLabel}
                    </TooltipContent>
                  </Tooltip>
                )}
                <DropdownMenuContent align="end" className="w-40">
                  {onCopyReviewLink && (
                    <DropdownMenuItem
                      onSelect={() => {
                        closeHover()
                        onCopyReviewLink()
                      }}
                    >
                      <Copy className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeCardReviewDetailSection.copyLink',
                        'Copy link'
                      )}
                    </DropdownMenuItem>
                  )}
                  {onUnlinkReview && (
                    <DropdownMenuItem
                      onSelect={() => {
                        closeHover()
                        onUnlinkReview()
                      }}
                    >
                      <Unlink className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeCardMeta.ae76907ca6',
                        'Unlink {{value0}}',
                        { value0: reviewLabel }
                      )}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {review.url && onOpenReviewInOrca && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.2c67730e07',
                  'Open in Orca'
                )}
                onClick={dismissAndOpenReview}
              >
                <MonitorUp className="size-3" />
              </MetadataActionIcon>
            )}
            {review.url && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.ad25c3ff05',
                  'View on {{value0}}',
                  { value0: reviewProvider }
                )}
                href={review.url}
              >
                <ExternalLink className="size-3" />
              </MetadataActionIcon>
            )}
          </>
        }
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {review.title}
        </div>
        {(review.state || (review.status && review.status !== 'neutral')) && (
          <div className="flex flex-wrap gap-1">
            <ReviewStateBadge state={review.state} label={reviewLabel} />
            <ReviewChecksBadge status={review.status} />
          </div>
        )}
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}
