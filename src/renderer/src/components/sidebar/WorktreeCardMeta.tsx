import React from 'react'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import {
  CircleDot,
  Ellipsis,
  ExternalLink,
  MonitorUp,
  Pencil,
  StickyNote,
  Unlink
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import CommentMarkdown from './CommentMarkdown'
import { WORKTREE_NATIVE_CONTEXT_MENU_ATTR } from './WorktreeContextMenu'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader, MetaIconBadge, MetadataActionIcon } from './WorktreeCardMetadataControls'
import {
  IssueStateBadge,
  LinearStateBadge,
  ReviewChecksBadge,
  ReviewStateBadge
} from './WorktreeCardMetadataStatusBadges'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { getReviewLabel, getProviderName, ReviewIcon } from './worktree-review-helpers'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardMetaBadgesProps,
  WorktreeCardMetaBadgesRootProps,
  WorktreeCardDetailsHoverProps
} from './worktree-card-meta-types'

export type {
  WorktreeCardIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardMetaBadgesProps,
  WorktreeCardMetaBadgesRootProps,
  WorktreeCardDetailsHoverProps
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
  branchName,
  workspaceTitle,
  detailsAfter,
  openDelay = 250,
  closeDelay = 120,
  onEditIssue,
  onEditComment,
  onOpenGitHubIssueInOrca,
  onOpenLinearIssueInOrca,
  onOpenReviewInOrca,
  onUnlinkReview,
  hoverControl
}: WorktreeCardDetailsHoverProps): React.JSX.Element {
  const internalHoverControl = useWorktreeCardDetailsHoverControl()
  const {
    hoverOpen,
    reviewMenuOpen,
    handleHoverOpenChange,
    handleReviewMenuOpenChange,
    closeHover
  } = hoverControl ?? internalHoverControl
  const dismissAndRun = React.useCallback(
    (handler: ((event: React.MouseEvent) => void) | undefined) => (event: React.MouseEvent) => {
      closeHover()
      handler?.(event)
    },
    [closeHover]
  )

  const showIdentityHeader = Boolean(branchName || workspaceTitle)

  if (
    !showIdentityHeader &&
    !hasWorktreeCardDetails({ issue, linearIssue, review, comment }) &&
    !detailsAfter
  ) {
    return children
  }

  const reviewLabel = review ? getReviewLabel(review) : null
  const reviewProvider = review ? getProviderName(review) : null
  const issueLabels = issue?.labels ?? []

  return (
    <HoverCard
      open={hoverOpen}
      onOpenChange={handleHoverOpenChange}
      openDelay={openDelay}
      closeDelay={closeDelay}
    >
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
          {showIdentityHeader && (
            <div className="min-w-0 border-l border-border/70 pl-2">
              {/* Why: the closed card no longer carries a branch row; custom-titled
                  worktrees still need their git branch available in the hover. */}
              {branchName && (
                <div className="truncate font-mono text-[11px] leading-none text-muted-foreground">
                  {branchName}
                </div>
              )}
              {workspaceTitle && workspaceTitle !== branchName && (
                <div className="mt-1 truncate text-[13px] font-semibold leading-snug text-foreground">
                  {workspaceTitle}
                </div>
              )}
            </div>
          )}

          {issue && (
            <WorktreeCardDetailSection>
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
              <WorktreeCardDetailSectionContent className="space-y-1.5">
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
              </WorktreeCardDetailSectionContent>
            </WorktreeCardDetailSection>
          )}

          {linearIssue && (
            <WorktreeCardDetailSection>
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
              <WorktreeCardDetailSectionContent className="space-y-1.5">
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
              </WorktreeCardDetailSectionContent>
            </WorktreeCardDetailSection>
          )}

          {review && reviewLabel && reviewProvider && (
            <WorktreeCardDetailSection>
              <DetailHeader
                icon={<ReviewIcon review={review} className="size-3" />}
                label={`${reviewLabel} #${review.number}`}
                actions={
                  <>
                    {onUnlinkReview && (
                      <DropdownMenu
                        modal={false}
                        open={reviewMenuOpen}
                        onOpenChange={handleReviewMenuOpenChange}
                      >
                        <Tooltip open={reviewMenuOpen ? false : undefined}>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="size-6"
                                aria-label={`More ${reviewLabel} actions`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <Ellipsis className="size-3" />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={4}>
                            More {reviewLabel} actions
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem
                            onSelect={() => {
                              closeHover()
                              onUnlinkReview?.()
                            }}
                          >
                            <Unlink className="size-3.5" />
                            Unlink {reviewLabel}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
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
          )}

          {hasComment(comment) && (
            <WorktreeCardDetailSection>
              <DetailHeader
                icon={<StickyNote className="size-3 text-muted-foreground" />}
                label="Notes"
                actions={
                  <MetadataActionIcon label="Edit notes" onClick={onEditComment}>
                    <Pencil className="size-3" />
                  </MetadataActionIcon>
                }
              />
              <WorktreeCardDetailSectionContent className="space-y-2">
                <CommentMarkdown
                  content={comment ?? ''}
                  className="text-[11.5px] text-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1"
                />
              </WorktreeCardDetailSectionContent>
            </WorktreeCardDetailSection>
          )}

          {detailsAfter}
        </SelectedTextCopyMenu>
      </HoverCardContent>
    </HoverCard>
  )
}
