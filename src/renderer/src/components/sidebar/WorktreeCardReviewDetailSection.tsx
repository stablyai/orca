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
import type { CardReviewList, CardReviewRow } from './worktree-card-attached-reviews'
import { getProviderName, getReviewLabel, ReviewIcon } from './worktree-review-helpers'

type WorktreeCardReviewDetailSectionProps = {
  review: WorktreeCardPrDisplay | null
  /** How this workspace's reviews should render: one detailed, or several as peers. */
  reviewList?: CardReviewList
  reviewMenuOpen: boolean
  onReviewMenuOpenChange: (open: boolean) => void
  onOpenReviewInOrca?: (event: React.MouseEvent) => void
  onCopyReviewLink?: () => void
  onUnlinkReview?: () => void
  closeHover: () => void
}

export function WorktreeCardReviewDetailSection({
  review,
  reviewList,
  reviewMenuOpen,
  onReviewMenuOpenChange,
  onOpenReviewInOrca,
  onCopyReviewLink,
  onUnlinkReview,
  closeHover
}: WorktreeCardReviewDetailSectionProps): React.JSX.Element | null {
  // Several reviews render as peers: singling one out as the header would make
  // the rest look secondary when they are the same branch going elsewhere.
  if (reviewList?.kind === 'list') {
    return <CardReviewListSection rows={reviewList.rows} />
  }
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

function CardReviewListSection({ rows }: { rows: readonly CardReviewRow[] }): React.JSX.Element {
  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<ReviewIcon review={toDisplay(rows[0])} className="size-3" />}
        label={translate(
          'auto.components.sidebar.WorktreeCardReviewDetailSection.reviewListHeader',
          '{{value0}} reviews',
          { value0: rows.length }
        )}
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        {rows.map((row) => (
          <CardReviewRowItem key={row.url} row={row} />
        ))}
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}

/**
 * One row per review, all rendered the same.
 *
 * The base ref leads because it is what tells two reviews off the same branch
 * apart. State and checks only show for the one Orca resolved on its own —
 * absent badges mean "not polled", not "not passing".
 */
function CardReviewRowItem({ row }: { row: CardReviewRow }): React.JSX.Element {
  const display = toDisplay(row)
  const label = getReviewLabel(display)

  return (
    <a
      href={row.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="group block rounded-sm px-1 py-1 -mx-1 hover:bg-accent"
      title={row.title ?? row.url}
    >
      <div className="flex items-center gap-1.5 text-[12px]">
        <ReviewIcon review={display} className="size-3 shrink-0" />
        <span className="font-medium tabular-nums shrink-0 text-foreground">
          {label} #{row.number}
        </span>
        {row.headRef && <span className="truncate text-muted-foreground">{row.headRef}</span>}
        {row.baseRef && (
          <span className="truncate text-muted-foreground">&rarr; {row.baseRef}</span>
        )}
        <ExternalLink className="size-3 ml-auto shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground" />
      </div>
      {row.title && (
        <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground break-words">
          {row.title}
        </div>
      )}
      {(row.state || (row.status && row.status !== 'neutral')) && (
        <div className="mt-1 flex flex-wrap gap-1">
          <ReviewStateBadge state={row.state} label={label} />
          <ReviewChecksBadge status={row.status} />
        </div>
      )}
    </a>
  )
}

function toDisplay(row: CardReviewRow): WorktreeCardPrDisplay {
  return {
    provider: row.provider,
    number: row.number,
    title: row.title ?? '',
    ...(row.state ? { state: row.state } : {}),
    ...(row.status ? { status: row.status } : {})
  }
}
