/* eslint-disable max-lines -- Why: the card metadata hover keeps compact badge rendering,
   provider-specific action rows, and markdown note preview together so the sidebar
   card has one metadata contract. */
import React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { CircleDot, ExternalLink, GitMerge, MonitorUp, Pencil, StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import CommentMarkdown from './CommentMarkdown'
import { PullRequestIcon } from './WorktreeCardHelpers'
import { WORKTREE_NATIVE_CONTEXT_MENU_ATTR } from './WorktreeContextMenu'
import {
  IssueStateBadge,
  LinearStateBadge,
  ReviewChecksBadge,
  ReviewStateBadge
} from './WorktreeCardMetadataStatusBadges'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { IssueInfo } from '../../../../shared/types'

export type WorktreeCardIssueDisplay =
  | IssueInfo
  | {
      number: number
      title: string
      state?: IssueInfo['state']
      url?: string
      labels?: string[]
    }

export type WorktreeCardLinearIssueDisplay = {
  identifier: string
  title: string
  url?: string
  stateName?: string
  labels?: string[]
}

type WorktreeCardMetaBadgesProps = {
  issue: WorktreeCardIssueDisplay | null
  linearIssue: WorktreeCardLinearIssueDisplay | null
  review: WorktreeCardPrDisplay | null
  comment: string | null
}

type WorktreeCardMetaBadgesRootProps = WorktreeCardMetaBadgesProps &
  React.HTMLAttributes<HTMLDivElement>

type WorktreeCardDetailsHoverProps = WorktreeCardMetaBadgesProps & {
  children: React.ReactElement
  detailsAfter?: React.ReactNode
  onEditIssue: (event: React.MouseEvent) => void
  onEditComment: (event: React.MouseEvent) => void
  onOpenGitHubIssueInOrca?: (event: React.MouseEvent) => void
  onOpenLinearIssueInOrca?: (event: React.MouseEvent) => void
  onOpenReviewInOrca?: (event: React.MouseEvent) => void
}

function hasComment(comment: string | null): boolean {
  return (comment ?? '').trim().length > 0
}

export function hasWorktreeCardDetails({
  issue,
  linearIssue,
  review,
  comment
}: WorktreeCardMetaBadgesProps): boolean {
  return Boolean(issue || linearIssue || review || hasComment(comment))
}

function getReviewLabel(review: WorktreeCardPrDisplay): 'MR' | 'PR' {
  return review.provider === 'gitlab' ? 'MR' : 'PR'
}

function getProviderName(review: WorktreeCardPrDisplay): string {
  if (review.provider === 'gitlab') {
    return 'GitLab'
  }
  if (review.provider === 'bitbucket') {
    return 'Bitbucket'
  }
  if (review.provider === 'azure-devops') {
    return 'Azure DevOps'
  }
  if (review.provider === 'gitea') {
    return 'Gitea'
  }
  return 'GitHub'
}

function ReviewIcon({
  review,
  className
}: {
  review: WorktreeCardPrDisplay
  className?: string
}): React.JSX.Element {
  const Icon = review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  // Why: the standalone CI glyph was removed from the card header, so linked
  // PR metadata carries check health unless the review is already merged.
  const checkTone =
    review.state !== 'merged' && review.status === 'failure'
      ? 'text-rose-500/85'
      : review.state !== 'merged' && review.status === 'pending'
        ? 'text-amber-500/85'
        : review.state === 'open' && review.status === 'success'
          ? 'text-emerald-500/80'
          : null
  return (
    <Icon
      className={cn(
        className,
        checkTone,
        review.state === 'merged' && 'text-purple-600/70 dark:text-purple-400/70',
        !checkTone && review.state === 'open' && 'text-emerald-500/80',
        !checkTone && review.state === 'closed' && 'text-muted-foreground/60',
        !checkTone && review.state === 'draft' && 'text-muted-foreground/50',
        !checkTone &&
          (!review.state || !['merged', 'open', 'closed', 'draft'].includes(review.state)) &&
          'text-muted-foreground opacity-70'
      )}
    />
  )
}

function MetaIconBadge({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground [&>svg]:size-3.5">
      {children}
      <span className="sr-only">{label}</span>
    </span>
  )
}

function DetailHeader({
  icon,
  label,
  actions
}: {
  icon: React.ReactNode
  label: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  )
}

function MetadataActionIcon({
  label,
  href,
  onClick,
  children
}: {
  label: string
  href?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}): React.JSX.Element {
  const trigger = href ? (
    <Button asChild variant="ghost" size="icon-xs" className="size-6">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </a>
    </Button>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-6"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
    >
      {children}
    </Button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export const WorktreeCardMetaBadges = React.forwardRef<
  HTMLDivElement,
  WorktreeCardMetaBadgesRootProps
>(function WorktreeCardMetaBadges(
  { issue, linearIssue, review, comment, className, ...props },
  ref
): React.JSX.Element | null {
  if (!hasWorktreeCardDetails({ issue, linearIssue, review, comment })) {
    return null
  }

  return (
    // Why: Radix HoverCardTrigger uses `asChild`, so this group must forward
    // trigger props/ref to the actual DOM node for attachment-only hover.
    <div
      ref={ref}
      {...props}
      className={cn('ml-auto flex shrink-0 items-center gap-1 pr-1.5', className)}
      aria-label="Workspace metadata"
    >
      {hasComment(comment) && (
        <MetaIconBadge label="Workspace notes">
          <StickyNote className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {issue && (
        <MetaIconBadge label={`Linked issue #${issue.number}`}>
          <CircleDot className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {linearIssue && (
        <MetaIconBadge label={`Linked Linear ${linearIssue.identifier}`}>
          <LinearIcon className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {review && (
        <MetaIconBadge label={`Linked ${getReviewLabel(review)} #${review.number}`}>
          <ReviewIcon review={review} />
        </MetaIconBadge>
      )}
    </div>
  )
})

export function WorktreeCardDetailsHover({
  issue,
  linearIssue,
  review,
  comment,
  children,
  detailsAfter,
  onEditIssue,
  onEditComment,
  onOpenGitHubIssueInOrca,
  onOpenLinearIssueInOrca,
  onOpenReviewInOrca
}: WorktreeCardDetailsHoverProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const dismissAndRun = React.useCallback(
    (handler: ((event: React.MouseEvent) => void) | undefined) => (event: React.MouseEvent) => {
      setOpen(false)
      handler?.(event)
    },
    []
  )

  if (!hasWorktreeCardDetails({ issue, linearIssue, review, comment }) && !detailsAfter) {
    return children
  }

  const reviewLabel = review ? getReviewLabel(review) : null
  const reviewProvider = review ? getProviderName(review) : null
  const issueLabels = issue?.labels ?? []

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-80 max-h-[28rem] overflow-y-auto p-3 text-xs scrollbar-sleek"
        {...{ [WORKTREE_NATIVE_CONTEXT_MENU_ATTR]: '' }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <SelectedTextCopyMenu className="space-y-3">
          {issue && (
            <section className="space-y-1.5">
              <DetailHeader
                icon={<CircleDot className="size-3 text-muted-foreground" />}
                label={`Issue #${issue.number}`}
                actions={
                  <>
                    {issue.url && onOpenGitHubIssueInOrca && (
                      <MetadataActionIcon
                        label="Open in Orca"
                        onClick={dismissAndRun(onOpenGitHubIssueInOrca)}
                      >
                        <MonitorUp className="size-3" />
                      </MetadataActionIcon>
                    )}
                    {issue.url && (
                      <MetadataActionIcon label="View on GitHub" href={issue.url}>
                        <ExternalLink className="size-3" />
                      </MetadataActionIcon>
                    )}
                    <MetadataActionIcon label="Edit issue" onClick={onEditIssue}>
                      <Pencil className="size-3" />
                    </MetadataActionIcon>
                  </>
                }
              />
              <div className="space-y-1.5">
                <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
                  {issue.title}
                </div>
                {(issue.state || issueLabels.length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {issue.state && <IssueStateBadge state={issue.state} />}
                    {issueLabels.map((label) => (
                      <Badge key={label} variant="outline" className="h-4 px-1.5 text-[9px]">
                        {label}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {linearIssue && (
            <section className="space-y-1.5">
              <DetailHeader
                icon={<LinearIcon className="size-3 text-muted-foreground" />}
                label={`Linear ${linearIssue.identifier}`}
                actions={
                  <>
                    {linearIssue.url && onOpenLinearIssueInOrca && (
                      <MetadataActionIcon
                        label="Open in Orca"
                        onClick={dismissAndRun(onOpenLinearIssueInOrca)}
                      >
                        <MonitorUp className="size-3" />
                      </MetadataActionIcon>
                    )}
                    {linearIssue.url && (
                      <MetadataActionIcon label="View on Linear" href={linearIssue.url}>
                        <ExternalLink className="size-3" />
                      </MetadataActionIcon>
                    )}
                  </>
                }
              />
              <div className="space-y-1.5">
                <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
                  {linearIssue.title}
                </div>
                {((linearIssue.labels && linearIssue.labels.length > 0) ||
                  linearIssue.stateName) && (
                  <div className="flex flex-wrap gap-1">
                    {linearIssue.stateName && (
                      <LinearStateBadge stateName={linearIssue.stateName} />
                    )}
                    {(linearIssue.labels ?? []).map((label) => (
                      <Badge key={label} variant="outline" className="h-4 px-1.5 text-[9px]">
                        {label}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {review && reviewLabel && reviewProvider && (
            <section className="space-y-1.5">
              <DetailHeader
                icon={<ReviewIcon review={review} className="size-3" />}
                label={`${reviewLabel} #${review.number}`}
                actions={
                  <>
                    {review.url && onOpenReviewInOrca && (
                      <MetadataActionIcon
                        label="Open in Orca"
                        onClick={dismissAndRun(onOpenReviewInOrca)}
                      >
                        <MonitorUp className="size-3" />
                      </MetadataActionIcon>
                    )}
                    {review.url && (
                      <MetadataActionIcon label={`View on ${reviewProvider}`} href={review.url}>
                        <ExternalLink className="size-3" />
                      </MetadataActionIcon>
                    )}
                  </>
                }
              />
              <div className="space-y-1.5">
                <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
                  {review.title}
                </div>
                {(review.state || (review.status && review.status !== 'neutral')) && (
                  <div className="flex flex-wrap gap-1">
                    <ReviewStateBadge state={review.state} label={reviewLabel} />
                    <ReviewChecksBadge status={review.status} />
                  </div>
                )}
              </div>
            </section>
          )}

          {hasComment(comment) && (
            <section className="space-y-1.5">
              <DetailHeader
                icon={<StickyNote className="size-3 text-muted-foreground" />}
                label="Notes"
                actions={
                  <MetadataActionIcon label="Edit notes" onClick={onEditComment}>
                    <Pencil className="size-3" />
                  </MetadataActionIcon>
                }
              />
              <div className="space-y-2">
                <CommentMarkdown
                  content={comment ?? ''}
                  className="text-[11.5px] text-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1"
                />
              </div>
            </section>
          )}

          {detailsAfter}
        </SelectedTextCopyMenu>
      </HoverCardContent>
    </HoverCard>
  )
}
