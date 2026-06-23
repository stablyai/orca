import React from 'react'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { CalendarClock, CircleDot, ExternalLink, MonitorUp, Pencil, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
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
import { LinearStateBadge } from './WorktreeCardMetadataStatusBadges'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardMetaBadgesProps,
  WorktreeCardMetaBadgesRootProps,
  WorktreeCardDetailsHoverProps
} from './worktree-card-meta-types'
import { translate } from '@/i18n/i18n'
import { WorktreeCardReviewDetailSection } from './WorktreeCardReviewDetailSection'
import { WorktreeCardAutomationDetailSection } from './WorktreeCardAutomationDetailSection'
import { WorktreeCardIssueDetailSection } from './WorktreeCardIssueDetailSection'

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
  comment,
  automationProvenance
}: WorktreeCardMetaBadgesProps): boolean {
  return Boolean(issue || linearIssue || review || hasComment(comment) || automationProvenance)
}

export const WorktreeCardMetaBadges = React.forwardRef<
  HTMLDivElement,
  WorktreeCardMetaBadgesRootProps
>(function WorktreeCardMetaBadges(
  { issue, linearIssue, review, comment, automationProvenance, className, ...props },
  ref
): React.JSX.Element | null {
  if (!hasWorktreeCardDetails({ issue, linearIssue, review, comment, automationProvenance })) {
    return null
  }

  return (
    // Why: Radix HoverCardTrigger uses `asChild`, so this group must forward
    // trigger props/ref to the actual DOM node for attachment-only hover.
    <div
      ref={ref}
      {...props}
      className={cn('ml-auto flex shrink-0 items-center gap-1 pr-1.5', className)}
      aria-label={translate(
        'auto.components.sidebar.WorktreeCardMeta.3e65e11cc6',
        'Workspace metadata'
      )}
    >
      {hasComment(comment) && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.fe075cb851',
            'Workspace notes'
          )}
        >
          <StickyNote className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {automationProvenance && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.automationCreated',
            'Created by automation'
          )}
        >
          <CalendarClock className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {issue && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.3f2649eeb8',
            'Linked issue #{{value0}}',
            { value0: issue.number }
          )}
        >
          <CircleDot className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {linearIssue && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.b105fd3057',
            'Linked Linear {{value0}}',
            { value0: linearIssue.identifier }
          )}
        >
          <LinearIcon className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {review && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.3ea2702e62',
            'Linked {{value0}} #{{value1}}',
            { value0: getReviewLabel(review), value1: review.number }
          )}
        >
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
  automationProvenance,
  children,
  branchName,
  workspaceTitle,
  identityOrder = 'workspace-first',
  automationHostId,
  detailsAfter,
  openDelay = 250,
  closeDelay = 120,
  onEditIssue,
  onEditComment,
  onOpenGitHubIssueInOrca,
  onOpenLinearIssueInOrca,
  onOpenReviewInOrca,
  onUnlinkReview,
  onOpenAutomation,
  onOpenAutomationRun,
  hoverControl
}: WorktreeCardDetailsHoverProps): React.JSX.Element {
  const internalHoverControl = useWorktreeCardDetailsHoverControl()
  const {
    hoverOpen,
    issueMenuOpen,
    reviewMenuOpen,
    handleHoverOpenChange,
    handleIssueMenuOpenChange,
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
  const copyLinkedWorkItemLink = React.useCallback(async (url: string, label: string) => {
    try {
      // Why: Electron clipboard IPC remains reliable from nested hover/dropdown
      // overlays where browser clipboard activation can be lost.
      await window.api.ui.writeClipboardText(url)
      toast.success(
        translate('auto.components.sidebar.WorktreeCardMeta.copyLinkSuccess', '{{value0}} copied', {
          value0: label
        })
      )
    } catch {
      toast.error(
        translate('auto.components.sidebar.WorktreeCardMeta.copyLinkFailure', 'Failed to copy link')
      )
    }
  }, [])
  const handleCopyIssueLink = React.useCallback((): void => {
    if (!issue?.url) {
      return
    }
    closeHover()
    void copyLinkedWorkItemLink(
      issue.url,
      translate('auto.components.sidebar.WorktreeCardMeta.issueLinkLabel', 'Issue link')
    )
  }, [closeHover, copyLinkedWorkItemLink, issue?.url])
  const handleCopyReviewLink = React.useCallback((): void => {
    if (!review?.url) {
      return
    }
    void copyLinkedWorkItemLink(
      review.url,
      translate('auto.components.sidebar.WorktreeCardMeta.reviewLinkLabel', '{{value0}} link', {
        value0: getReviewLabel(review)
      })
    )
  }, [copyLinkedWorkItemLink, review])

  const showIdentityHeader = Boolean(branchName || workspaceTitle)

  if (
    !showIdentityHeader &&
    !hasWorktreeCardDetails({ issue, linearIssue, review, comment, automationProvenance }) &&
    !detailsAfter
  ) {
    return children
  }

  const branchIdentity = branchName ? (
    <div
      className={cn(
        // Why: the hover panel is where users read full git identity; wrap instead
        // of truncating so long branch names stay readable like issue titles below.
        'break-words font-mono text-[11px] leading-snug text-muted-foreground',
        identityOrder === 'workspace-first' && 'mt-1'
      )}
    >
      {branchName}
    </div>
  ) : null
  const workspaceIdentity =
    workspaceTitle && workspaceTitle !== branchName ? (
      <div
        className={cn(
          'break-words text-[13px] font-semibold leading-snug text-foreground',
          identityOrder === 'branch-first' && 'mt-1'
        )}
      >
        {workspaceTitle}
      </div>
    ) : null

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
              {identityOrder === 'branch-first' ? branchIdentity : workspaceIdentity}
              {identityOrder === 'branch-first' ? workspaceIdentity : branchIdentity}
            </div>
          )}

          <WorktreeCardIssueDetailSection
            issue={issue}
            issueMenuOpen={issueMenuOpen}
            onIssueMenuOpenChange={handleIssueMenuOpenChange}
            onCopyIssueLink={issue?.url ? handleCopyIssueLink : undefined}
            onEditIssue={onEditIssue}
            onOpenGitHubIssueInOrca={
              onOpenGitHubIssueInOrca ? dismissAndRun(onOpenGitHubIssueInOrca) : undefined
            }
          />

          {linearIssue && (
            <WorktreeCardDetailSection>
              <DetailHeader
                icon={<LinearIcon className="size-3 text-muted-foreground" />}
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.5e982e6128',
                  'Linear {{value0}}',
                  { value0: linearIssue.identifier }
                )}
                actions={
                  <>
                    {linearIssue.url && onOpenLinearIssueInOrca && (
                      <MetadataActionIcon
                        label={translate(
                          'auto.components.sidebar.WorktreeCardMeta.2c67730e07',
                          'Open in Orca'
                        )}
                        onClick={dismissAndRun(onOpenLinearIssueInOrca)}
                      >
                        <MonitorUp className="size-3" />
                      </MetadataActionIcon>
                    )}
                    {linearIssue.url && (
                      <MetadataActionIcon
                        label={translate(
                          'auto.components.sidebar.WorktreeCardMeta.e42941631a',
                          'View on Linear'
                        )}
                        href={linearIssue.url}
                      >
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

          <WorktreeCardReviewDetailSection
            review={review}
            reviewMenuOpen={reviewMenuOpen}
            onReviewMenuOpenChange={handleReviewMenuOpenChange}
            onOpenReviewInOrca={onOpenReviewInOrca}
            onCopyReviewLink={review?.url ? handleCopyReviewLink : undefined}
            onUnlinkReview={onUnlinkReview}
            closeHover={closeHover}
          />

          {automationProvenance && (
            <WorktreeCardAutomationDetailSection
              provenance={automationProvenance}
              worktreeHostId={automationHostId}
              onOpenAutomation={onOpenAutomation ? dismissAndRun(onOpenAutomation) : undefined}
              onOpenAutomationRun={
                onOpenAutomationRun ? dismissAndRun(onOpenAutomationRun) : undefined
              }
            />
          )}

          {hasComment(comment) && (
            <WorktreeCardDetailSection>
              <DetailHeader
                icon={<StickyNote className="size-3 text-muted-foreground" />}
                label={translate('auto.components.sidebar.WorktreeCardMeta.93cbea12c2', 'Notes')}
                actions={
                  onEditComment ? (
                    <MetadataActionIcon
                      label={translate(
                        'auto.components.sidebar.WorktreeCardMeta.c7fa72ead0',
                        'Edit notes'
                      )}
                      onClick={onEditComment}
                    >
                      <Pencil className="size-3" />
                    </MetadataActionIcon>
                  ) : null
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
