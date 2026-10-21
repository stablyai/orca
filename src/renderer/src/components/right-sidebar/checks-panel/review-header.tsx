import React from 'react'
import { Ellipsis, GitMerge, Link, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  getTerminalUrlOrcaBrowserHint,
  getTerminalUrlSystemBrowserHint
} from '../../terminal-pane/terminal-link-open-hints'
import type { ChecksPanelReview } from '../checks-panel-review'
import type { ChecksPanelHostedReviewModifierDestination } from '../checks-panel-hosted-review-click-routing'
import { translate } from '@/i18n/i18n'
import { PullRequestIcon, prStateColor } from './check-presentation'
import { HostedReviewUnlinkMenuItem } from '@/components/HostedReviewUnlinkMenuItem'

type ChecksPanelReviewHeaderProps = {
  review: ChecksPanelReview
  isRefreshing: boolean
  canUnlinkReview: boolean
  modifierHintDestination: ChecksPanelHostedReviewModifierDestination
  onRefresh: () => void
  onOpenReview: (event: React.MouseEvent<HTMLButtonElement>) => void
  onUnlinkReview: () => void
  onLinkAnotherReview: () => void
}

export function ChecksPanelReviewHeader({
  review,
  isRefreshing,
  canUnlinkReview,
  modifierHintDestination,
  onRefresh,
  onOpenReview,
  onUnlinkReview,
  onLinkAnotherReview
}: ChecksPanelReviewHeaderProps): React.JSX.Element {
  const reviewNumberLabel = review.provider === 'gitlab' ? `!${review.number}` : `#${review.number}`
  const ReviewIcon = review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const reviewHostLabel = review.provider === 'gitlab' ? 'GitLab' : 'GitHub'
  const moreActionsLabel =
    review.provider === 'gitlab'
      ? translate('auto.components.right.sidebar.ChecksPanel.gitlabMoreActions', 'More MR actions')
      : translate('auto.components.right.sidebar.ChecksPanel.653c105ecc', 'More PR actions')
  const openTitle = translate(
    'auto.components.right.sidebar.ChecksPanel.5c88c6db07',
    'Open on {{value0}}',
    { value0: reviewHostLabel }
  )
  const modifierHint =
    modifierHintDestination === 'system-browser'
      ? getTerminalUrlSystemBrowserHint()
      : modifierHintDestination === 'orca'
        ? getTerminalUrlOrcaBrowserHint()
        : null
  const title = modifierHint ? `${openTitle}. ${modifierHint}` : openTitle

  return (
    <div className="flex items-center gap-2">
      <ReviewIcon className="size-4 text-muted-foreground shrink-0" />
      <button
        type="button"
        className="rounded px-0.5 text-[12px] font-semibold text-foreground underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={title}
        onClick={onOpenReview}
      >
        {reviewNumberLabel}
      </button>
      <span
        className={cn(
          'text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border',
          prStateColor(review.state)
        )}
      >
        {review.state}
      </span>
      <div className="flex-1" />
      <button
        className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
        title={translate('auto.components.right.sidebar.ChecksPanel.7f4489f370', 'Refresh')}
        onClick={onRefresh}
        disabled={isRefreshing}
      >
        <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={moreActionsLabel}
            title={moreActionsLabel}
            className="text-muted-foreground hover:text-foreground"
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <HostedReviewUnlinkMenuItem
            reviewLabel={review.provider === 'gitlab' ? 'MR' : 'PR'}
            reviewIdentifier={reviewNumberLabel}
            providerLabel={reviewHostLabel}
            disabled={!canUnlinkReview}
            onSelect={onUnlinkReview}
          />
          <DropdownMenuItem onSelect={onLinkAnotherReview}>
            <Link className="size-3.5" />
            {review.provider === 'gitlab'
              ? translate(
                  'auto.components.right.sidebar.ChecksPanel.gitlabLinkAnother',
                  'Link another MR'
                )
              : translate(
                  'auto.components.right.sidebar.ChecksPanel.07871c0589',
                  'Link another PR'
                )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
