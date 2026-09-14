import React, { useCallback } from 'react'
import { ExternalLink, MonitorUp, Pencil, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { translate } from '@/i18n/i18n'
import CommentMarkdown from '../sidebar/CommentMarkdown'
import { DetailHeader, MetadataActionIcon } from '../sidebar/WorktreeCardMetadataControls'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from '../sidebar/WorktreeCardDetailSection'
import { LinearStateBadge } from '../sidebar/WorktreeCardMetadataStatusBadges'
import { WorktreeCardIssueDetailSection } from '../sidebar/WorktreeCardIssueDetailSection'
import { WorktreeCardReviewDetailSection } from '../sidebar/WorktreeCardReviewDetailSection'
import { WorktreeCardAutomationDetailSection } from '../sidebar/WorktreeCardAutomationDetailSection'
import { WorktreeCardCliDetailSection } from '../sidebar/WorktreeCardCliDetailSection'
import { WorktreeCardPortsDetails } from '../sidebar/WorktreeCardPorts'
import { WORKTREE_NATIVE_CONTEXT_MENU_ATTR } from '../sidebar/WorktreeContextMenu'
import { useWorktreeCardDetailsHoverControl } from '../sidebar/worktree-card-details-hover-state'
import { useWorktreeCardFoundation } from '../sidebar/use-worktree-card-foundation'
import { useWorktreeCardReviewDetails } from '../sidebar/use-worktree-card-review-details'
import { useWorktreeCardLinkedDetails } from '../sidebar/use-worktree-card-linked-details'
import { useWorktreeCardLifecycleEffects } from '../sidebar/use-worktree-card-lifecycle-effects'
import { useWorktreeCardSecondaryDetails } from '../sidebar/use-worktree-card-secondary-details'
import { getReviewLabel } from '../sidebar/worktree-review-helpers'
import { ActivityThreadHoverCardSummary } from './activity-thread-hover-card-summary'
import type { AgentPaneThread } from './activity-thread-types'

export type ActivityThreadHoverCardProps = {
  thread: AgentPaneThread
  children: React.ReactElement
  openDelay?: number
  closeDelay?: number
  onJumpToWorkspace?: (thread: AgentPaneThread) => void
  canJumpToWorkspace?: boolean
}

export function ActivityThreadHoverCard({
  thread,
  children,
  openDelay = 200,
  closeDelay = 120,
  onJumpToWorkspace,
  canJumpToWorkspace
}: ActivityThreadHoverCardProps): React.JSX.Element {
  const detailsHoverControl = useWorktreeCardDetailsHoverControl()

  return (
    <HoverCard
      open={detailsHoverControl.hoverOpen}
      onOpenChange={detailsHoverControl.handleHoverOpenChange}
      openDelay={openDelay}
      closeDelay={closeDelay}
    >
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {detailsHoverControl.hoverOpen ? (
        <ActivityThreadHoverCardContent
          thread={thread}
          detailsHoverControl={detailsHoverControl}
          onJumpToWorkspace={onJumpToWorkspace}
          canJumpToWorkspace={canJumpToWorkspace}
        />
      ) : null}
    </HoverCard>
  )
}

function ActivityThreadHoverCardContent({
  thread,
  detailsHoverControl,
  onJumpToWorkspace,
  canJumpToWorkspace
}: {
  thread: AgentPaneThread
  detailsHoverControl: ReturnType<typeof useWorktreeCardDetailsHoverControl>
  onJumpToWorkspace?: (thread: AgentPaneThread) => void
  canJumpToWorkspace?: boolean
}): React.JSX.Element {
  const { worktree, repo } = thread
  const foundation = useWorktreeCardFoundation({ worktree, repo: repo ?? undefined })
  const review = useWorktreeCardReviewDetails({
    worktree,
    repo: repo ?? undefined,
    settings: foundation.settings,
    projectGroups: foundation.projectGroups,
    cardProps: foundation.cardProps,
    newCardStyle: foundation.newCardStyle
  })
  const linked = useWorktreeCardLinkedDetails({
    worktree,
    newCardStyle: foundation.newCardStyle,
    deleteState: foundation.deleteState,
    branch: review.branch,
    issueEntry: review.issueEntry,
    linearIssueEntry: review.linearIssueEntry,
    linearIssueFallbackEntry: review.linearIssueFallbackEntry,
    prDisplay: review.prDisplay
  })

  const hoverDetailsOpen = detailsHoverControl.hoverOpen

  useWorktreeCardLifecycleEffects({
    worktree,
    repo: repo ?? undefined,
    isFolder: review.isFolder,
    hostedReviewCacheKey: review.hostedReviewCacheKey,
    cachedBranchFallbackGitHubPRNumber: review.cachedBranchFallbackGitHubPRNumber,
    linkedGitLabMR: review.linkedGitLabMR,
    linkedBitbucketPR: review.linkedBitbucketPR,
    linkedAzureDevOpsPR: review.linkedAzureDevOpsPR,
    linkedGiteaPR: review.linkedGiteaPR,
    branch: review.branch,
    fetchHostedReviewForBranch: foundation.fetchHostedReviewForBranch,
    shouldRefreshHostedReview: false,
    newCardStyle: true,
    hoverDetailsOpen,
    showIssue: true,
    issueCacheKey: review.issueCacheKey,
    fetchIssue: foundation.fetchIssue,
    showLinearIssue: true,
    fetchLinearIssue: foundation.fetchLinearIssue
  })

  const secondary = useWorktreeCardSecondaryDetails({
    worktree,
    repo: repo ?? undefined,
    statusPrDisplay: null,
    showStatus: true,
    showIssue: true,
    showLinearIssue: true,
    showJiraIssue: true,
    showPR: true,
    showAutomation: true,
    showCli: true,
    showComment: true,
    showPorts: true,
    issueDisplay: linked.issueDisplay,
    linearIssue: linked.linearIssue,
    linearIssueDisplay: linked.linearIssueDisplay,
    jiraIssueDisplay: linked.jiraIssueDisplay,
    prDisplay: review.prDisplay,
    linkedGitLabMR: review.linkedGitLabMR,
    linkedBitbucketPR: review.linkedBitbucketPR,
    linkedAzureDevOpsPR: review.linkedAzureDevOpsPR,
    linkedGiteaPR: review.linkedGiteaPR,
    cardProps: foundation.cardProps,
    newCardStyle: foundation.newCardStyle,
    compactCards: foundation.compactCards,
    agentActivityDisplayMode: foundation.agentActivityDisplayMode,
    workspacePorts: foundation.workspacePorts,
    openTaskPage: foundation.openTaskPage,
    updateWorktreeMeta: foundation.updateWorktreeMeta,
    settings: foundation.settings
  })

  const copyLinkedWorkItemLink = useCallback(async (url: string, label: string) => {
    try {
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

  const handleCopyIssueLink = useCallback(() => {
    if (!secondary.hoverIssue?.url) {
      return
    }
    detailsHoverControl.closeHover()
    void copyLinkedWorkItemLink(
      secondary.hoverIssue.url,
      translate('auto.components.sidebar.WorktreeCardMeta.issueLinkLabel', 'Issue link')
    )
  }, [copyLinkedWorkItemLink, detailsHoverControl, secondary.hoverIssue?.url])

  const handleCopyReviewLink = useCallback(() => {
    if (!secondary.hoverReview?.url) {
      return
    }
    void copyLinkedWorkItemLink(
      secondary.hoverReview.url,
      translate('auto.components.sidebar.WorktreeCardMeta.reviewLinkLabel', '{{value0}} link', {
        value0: getReviewLabel(secondary.hoverReview)
      })
    )
  }, [copyLinkedWorkItemLink, secondary.hoverReview])

  const dismissAndRun = useCallback(
    (handler: ((event: React.MouseEvent) => void) | undefined) => (event: React.MouseEvent) => {
      detailsHoverControl.closeHover()
      handler?.(event)
    },
    [detailsHoverControl]
  )

  return (
    <HoverCardContent
      side="right"
      align="start"
      sideOffset={8}
      className="w-80 max-h-[30rem] overflow-y-auto p-3 text-xs scrollbar-sleek"
      {...{ [WORKTREE_NATIVE_CONTEXT_MENU_ATTR]: '' }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <SelectedTextCopyMenu className="space-y-3">
        <ActivityThreadHoverCardSummary
          thread={thread}
          settings={foundation.settings}
          onJumpToWorkspace={
            onJumpToWorkspace ? dismissAndRun(() => onJumpToWorkspace(thread)) : undefined
          }
          canJumpToWorkspace={canJumpToWorkspace}
        />

        {/* GitHub / GitLab Issue */}
        <WorktreeCardIssueDetailSection
          issue={secondary.hoverIssue}
          issueMenuOpen={detailsHoverControl.issueMenuOpen}
          onIssueMenuOpenChange={detailsHoverControl.handleIssueMenuOpenChange}
          onCopyIssueLink={secondary.hoverIssue?.url ? handleCopyIssueLink : undefined}
          onEditIssue={foundation.handleEditIssue}
          onOpenGitHubIssueInOrca={
            secondary.handleOpenGitHubIssueInOrca
              ? dismissAndRun(secondary.handleOpenGitHubIssueInOrca)
              : undefined
          }
          onOpenIssueInBrowser={
            secondary.hoverIssue?.url
              ? (url: string) => {
                  detailsHoverControl.closeHover()
                  secondary.handleOpenIssueInBrowser(url)
                }
              : undefined
          }
        />

        {/* Linear Issue */}
        {secondary.hoverLinearIssue && (
          <WorktreeCardDetailSection>
            <DetailHeader
              icon={<LinearIcon className="size-3 text-muted-foreground" />}
              label={translate(
                'auto.components.sidebar.WorktreeCardMeta.5e982e6128',
                'Linear {{value0}}',
                { value0: secondary.hoverLinearIssue.identifier }
              )}
              actions={
                <>
                  {secondary.hoverLinearIssue.url && secondary.handleOpenLinearIssueInOrca && (
                    <MetadataActionIcon
                      label={translate(
                        'auto.components.sidebar.WorktreeCardMeta.2c67730e07',
                        'Open in Orca'
                      )}
                      onClick={dismissAndRun(secondary.handleOpenLinearIssueInOrca)}
                    >
                      <MonitorUp className="size-3" />
                    </MetadataActionIcon>
                  )}
                  {secondary.hoverLinearIssue.url && (
                    <MetadataActionIcon
                      label={translate(
                        'auto.components.sidebar.WorktreeCardMeta.e42941631a',
                        'View on Linear'
                      )}
                      href={secondary.hoverLinearIssue.url}
                    >
                      <ExternalLink className="size-3" />
                    </MetadataActionIcon>
                  )}
                </>
              }
            />
            <WorktreeCardDetailSectionContent className="space-y-1.5">
              <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
                {secondary.hoverLinearIssue.title}
              </div>
              {((secondary.hoverLinearIssue.labels &&
                secondary.hoverLinearIssue.labels.length > 0) ||
                secondary.hoverLinearIssue.stateName) && (
                <div className="flex flex-wrap gap-1">
                  {secondary.hoverLinearIssue.stateName && (
                    <LinearStateBadge stateName={secondary.hoverLinearIssue.stateName} />
                  )}
                  {(secondary.hoverLinearIssue.labels ?? []).map((label) => (
                    <Badge key={label} variant="outline" className="h-4 px-1.5 text-[9px]">
                      {label}
                    </Badge>
                  ))}
                </div>
              )}
            </WorktreeCardDetailSectionContent>
          </WorktreeCardDetailSection>
        )}

        {/* Jira Issue */}
        {secondary.hoverJiraIssue && (
          <WorktreeCardDetailSection>
            <DetailHeader
              icon={<JiraIcon className="size-3 text-muted-foreground" />}
              label={translate(
                'auto.components.sidebar.WorktreeCardMeta.jiraIssue',
                'Jira {{value0}}',
                { value0: secondary.hoverJiraIssue.identifier }
              )}
              actions={
                <MetadataActionIcon
                  label={translate(
                    'auto.components.sidebar.WorktreeCardMeta.viewOnJira',
                    'View on Jira'
                  )}
                  href={secondary.hoverJiraIssue.url}
                >
                  <ExternalLink className="size-3" />
                </MetadataActionIcon>
              }
            />
            <WorktreeCardDetailSectionContent>
              <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
                {secondary.hoverJiraIssue.title}
              </div>
            </WorktreeCardDetailSectionContent>
          </WorktreeCardDetailSection>
        )}

        {/* Pull Request / Review */}
        <WorktreeCardReviewDetailSection
          review={secondary.hoverReview}
          reviewMenuOpen={detailsHoverControl.reviewMenuOpen}
          onReviewMenuOpenChange={detailsHoverControl.handleReviewMenuOpenChange}
          onOpenReviewInOrca={secondary.handleOpenReviewInOrca}
          onOpenReviewInBrowser={
            secondary.hoverReview?.url ? secondary.handleOpenReviewInBrowser : undefined
          }
          onCopyReviewLink={secondary.hoverReview?.url ? handleCopyReviewLink : undefined}
          onUnlinkReview={secondary.canUnlinkReview ? secondary.handleUnlinkReview : undefined}
          closeHover={detailsHoverControl.closeHover}
        />

        {/* Automation Provenance */}
        {secondary.metaAutomationProvenance && (
          <WorktreeCardAutomationDetailSection
            provenance={secondary.metaAutomationProvenance}
            onOpenAutomation={
              foundation.handleOpenAutomation
                ? dismissAndRun(foundation.handleOpenAutomation)
                : undefined
            }
            onOpenAutomationRun={
              foundation.handleOpenAutomationRun
                ? dismissAndRun(foundation.handleOpenAutomationRun)
                : undefined
            }
          />
        )}

        {/* CLI Provenance */}
        {secondary.metaCliProvenance && (
          <WorktreeCardCliDetailSection provenance={secondary.metaCliProvenance} />
        )}

        {/* Notes / Comment */}
        {(secondary.hoverComment ?? '').trim().length > 0 && (
          <WorktreeCardDetailSection>
            <DetailHeader
              icon={<StickyNote className="size-3 text-muted-foreground" />}
              label={translate('auto.components.sidebar.WorktreeCardMeta.93cbea12c2', 'Notes')}
              actions={
                <MetadataActionIcon
                  label={translate(
                    'auto.components.sidebar.WorktreeCardMeta.c7fa72ead0',
                    'Edit notes'
                  )}
                  onClick={foundation.handleEditComment}
                >
                  <Pencil className="size-3" />
                </MetadataActionIcon>
              }
            />
            <WorktreeCardDetailSectionContent className="space-y-2">
              <CommentMarkdown
                content={secondary.hoverComment ?? ''}
                className="text-[11.5px] text-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1"
              />
            </WorktreeCardDetailSectionContent>
          </WorktreeCardDetailSection>
        )}

        {/* Ports */}
        {foundation.workspacePorts.length > 0 && (
          <WorktreeCardPortsDetails ports={foundation.workspacePorts} />
        )}
      </SelectedTextCopyMenu>
    </HoverCardContent>
  )
}
