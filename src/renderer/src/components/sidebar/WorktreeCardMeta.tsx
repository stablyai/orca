import React from 'react'
import { useWorkspaceReferenceLinkActions } from './use-workspace-reference-link-actions'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { WorktreeCardLinkedItemsSection } from './WorktreeCardLinkedItemsSection'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { Pencil, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { WORKTREE_NATIVE_CONTEXT_MENU_ATTR } from './WorktreeContextMenu'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader, MetadataActionIcon } from './WorktreeCardMetadataControls'
import { hasWorktreeCardDetails, WorktreeCardMetaBadges } from './WorktreeCardMetaBadges'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { WorktreeCardLinkedReviewActions } from './WorktreeCardReviewActions'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardJiraIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardMetaBadgesProps,
  WorktreeCardMetaBadgesRootProps,
  WorktreeCardDetailsHoverProps
} from './worktree-card-meta-types'
import { translate } from '@/i18n/i18n'
import { WorktreeCardReviewDetailSection } from './WorktreeCardReviewDetailSection'
import { WorktreeCardAutomationDetailSection } from './WorktreeCardAutomationDetailSection'
import { WorktreeCardCliDetailSection } from './WorktreeCardCliDetailSection'
import {
  WorktreeCardLinkedTaskActions,
  WorktreeCardTaskDetailSection
} from './WorktreeCardTaskDetailSection'
import { WorktreeCardHoverIdentityHeader } from './WorktreeCardHoverIdentityHeader'
import { CommentMarkdownAsync, preloadCommentMarkdown } from './comment-markdown-lazy'

const COMMENT_MARKDOWN_CLASS_NAME =
  'text-[11.5px] text-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1'

export type {
  WorktreeCardIssueDisplay,
  WorktreeCardJiraIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardMetaBadgesProps,
  WorktreeCardMetaBadgesRootProps,
  WorktreeCardDetailsHoverProps
}

export { hasWorktreeCardDetails, WorktreeCardMetaBadges }

function hasComment(comment: string | null): boolean {
  return (comment ?? '').trim().length > 0
}

export function WorktreeCardDetailsHover({
  workspace,
  referenceDetails,
  onManageLinks,
  issue,
  linearIssue,
  jiraIssue,
  review,
  comment,
  automationProvenance,
  cliProvenance,
  children,
  branchName,
  workspaceTitle,
  identityOrder = 'workspace-first',
  workspaceTitleRenameDisabled = false,
  detailsAfter,
  openDelay = 250,
  closeDelay = 120,
  onRenameWorkspaceTitle,
  onWorkspaceTitleEditingChange,
  onEditIssue,
  onEditComment,
  onOpenGitHubIssueInOrca,
  onOpenIssueInBrowser,
  onOpenLinearIssueInOrca,
  onOpenReviewInOrca,
  onUnlinkReview,
  onOpenAutomation,
  onOpenAutomationRun,
  hoverControl
}: WorktreeCardDetailsHoverProps): React.JSX.Element {
  const internalHoverControl = useWorktreeCardDetailsHoverControl()
  const detailsHoverControl = hoverControl ?? internalHoverControl
  const {
    hoverOpen,
    issueMenuOpen,
    reviewMenuOpen,
    handleHoverOpenChange,
    handleIssueMenuOpenChange,
    handleReviewMenuOpenChange,
    closeHover
  } = detailsHoverControl
  const { linkActionPopoverProps, onOpenLink, onAuxClickCapture } =
    useWorkspaceReferenceLinkActions(workspace?.id, detailsHoverControl)
  const [workspaceTitleEditing, setWorkspaceTitleEditing] = React.useState(false)
  const pendingWorkspaceTitleCloseRef = React.useRef(false)
  const handleWorkspaceTitleEditingChange = React.useCallback(
    (editing: boolean): void => {
      setWorkspaceTitleEditing(editing)
      onWorkspaceTitleEditingChange?.(editing)
      if (!editing && pendingWorkspaceTitleCloseRef.current) {
        pendingWorkspaceTitleCloseRef.current = false
        handleHoverOpenChange(false)
      }
    },
    [handleHoverOpenChange, onWorkspaceTitleEditingChange]
  )
  const handleEffectiveHoverOpenChange = React.useCallback(
    (next: boolean): void => {
      if (!next && workspaceTitleEditing) {
        pendingWorkspaceTitleCloseRef.current = true
        return
      }
      pendingWorkspaceTitleCloseRef.current = false
      handleHoverOpenChange(next)
    },
    [handleHoverOpenChange, workspaceTitleEditing]
  )
  const dismissAndRun = React.useCallback(
    (handler: ((event: React.MouseEvent) => void) | undefined) => (event: React.MouseEvent) => {
      closeHover()
      handler?.(event)
    },
    [closeHover]
  )
  const copyLinkedWorkItemLink = React.useCallback(async (url: string, label: string) => {
    try {
      // Electron clipboard IPC survives nested overlays that can lose browser activation.
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
  const handleCopyIssueLink = React.useCallback(
    (url: string): void => {
      closeHover()
      void copyLinkedWorkItemLink(
        url,
        translate('auto.components.sidebar.WorktreeCardMeta.issueLinkLabel', 'Issue link')
      )
    },
    [closeHover, copyLinkedWorkItemLink]
  )
  const handleOpenTaskInBrowser = onOpenIssueInBrowser
    ? (url: string): void => {
        closeHover()
        onOpenIssueInBrowser(url)
      }
    : undefined
  const showIdentityHeader = Boolean(branchName || workspaceTitle)
  const attachments = getWorkspaceAttachments(workspace ?? {})
  const showAttachmentCollection =
    attachments.length > 1 ||
    (attachments.length === 1 && !issue && !linearIssue && !jiraIssue && !review)

  if (
    !showIdentityHeader &&
    attachments.length === 0 &&
    !onManageLinks &&
    !hasWorktreeCardDetails({
      issue,
      linearIssue,
      jiraIssue,
      review,
      comment,
      automationProvenance,
      cliProvenance
    }) &&
    !detailsAfter
  ) {
    return children
  }

  return (
    <HoverCard
      open={hoverOpen || workspaceTitleEditing}
      onOpenChange={handleEffectiveHoverOpenChange}
      openDelay={openDelay}
      closeDelay={closeDelay}
    >
      <span className="contents" onClick={(event) => event.stopPropagation()}>
        <LinkActionPopover {...linkActionPopoverProps} />
      </span>
      <HoverCardTrigger
        asChild
        onPointerEnter={hasComment(comment) ? preloadCommentMarkdown : undefined}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        variant="workspace-details"
        {...{ [WORKTREE_NATIVE_CONTEXT_MENU_ATTR]: '' }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onAuxClickCapture={onAuxClickCapture}
      >
        <SelectedTextCopyMenu className="space-y-3">
          {showIdentityHeader && (
            <WorktreeCardHoverIdentityHeader
              branchName={branchName}
              workspaceTitle={workspaceTitle}
              identityOrder={identityOrder}
              workspaceTitleRenameDisabled={workspaceTitleRenameDisabled}
              onRenameWorkspaceTitle={onRenameWorkspaceTitle}
              onWorkspaceTitleEditingChange={handleWorkspaceTitleEditingChange}
            />
          )}

          {!showAttachmentCollection ? (
            <>
              <WorktreeCardReviewDetailSection
                review={review}
                onManageLinks={onManageLinks ? dismissAndRun(onManageLinks) : undefined}
                reviewMenuOpen={reviewMenuOpen}
                onReviewMenuOpenChange={handleReviewMenuOpenChange}
                onOpenReviewInOrca={onOpenReviewInOrca}
                onOpenLink={onOpenLink}
                onUnlinkReview={onUnlinkReview}
                closeHover={closeHover}
              />

              <WorktreeCardTaskDetailSection
                issue={issue}
                linearIssue={linearIssue}
                jiraIssue={jiraIssue}
                onManageLinks={onManageLinks ? dismissAndRun(onManageLinks) : undefined}
                issueMenuOpen={issueMenuOpen}
                onIssueMenuOpenChange={handleIssueMenuOpenChange}
                onOpenLink={onOpenLink}
                onCopyLink={handleCopyIssueLink}
                onEditIssue={onEditIssue}
                onOpenGitHubIssueInOrca={
                  onOpenGitHubIssueInOrca ? dismissAndRun(onOpenGitHubIssueInOrca) : undefined
                }
                onOpenIssueInBrowser={handleOpenTaskInBrowser}
                onOpenLinearIssueInOrca={
                  onOpenLinearIssueInOrca ? dismissAndRun(onOpenLinearIssueInOrca) : undefined
                }
              />
            </>
          ) : null}
          <WorktreeCardLinkedItemsSection
            workspace={workspace}
            referenceDetails={referenceDetails}
            review={review}
            issue={issue}
            linearIssue={linearIssue}
            jiraIssue={jiraIssue}
            showItems={showAttachmentCollection}
            onManage={onManageLinks ? dismissAndRun(onManageLinks) : undefined}
            onOpen={onOpenLink}
            renderTaskActions={(item, url, isCardTask) => (
              <WorktreeCardLinkedTaskActions
                item={item}
                url={url}
                isCardTask={isCardTask}
                onOpenChange={handleIssueMenuOpenChange}
                onCopyLink={handleCopyIssueLink}
                onEditIssue={onEditIssue}
                onOpenGitHubIssueInOrca={
                  onOpenGitHubIssueInOrca ? dismissAndRun(onOpenGitHubIssueInOrca) : undefined
                }
                onOpenIssueInBrowser={handleOpenTaskInBrowser}
                onOpenLinearIssueInOrca={
                  onOpenLinearIssueInOrca ? dismissAndRun(onOpenLinearIssueInOrca) : undefined
                }
              />
            )}
            renderReviewActions={(item, live) => (
              <WorktreeCardLinkedReviewActions
                item={item}
                review={live}
                onOpenChange={handleReviewMenuOpenChange}
                onOpenInOrca={onOpenReviewInOrca}
                onUnlink={onUnlinkReview}
                closeHover={closeHover}
              />
            )}
          />

          {automationProvenance && (
            <WorktreeCardAutomationDetailSection
              provenance={automationProvenance}
              onOpenAutomation={onOpenAutomation ? dismissAndRun(onOpenAutomation) : undefined}
              onOpenAutomationRun={
                onOpenAutomationRun ? dismissAndRun(onOpenAutomationRun) : undefined
              }
            />
          )}

          {cliProvenance && <WorktreeCardCliDetailSection provenance={cliProvenance} />}

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
                <CommentMarkdownAsync
                  content={comment ?? ''}
                  className={COMMENT_MARKDOWN_CLASS_NAME}
                  // Mirrors remark-breaks so the fallback keeps the note's line count.
                  fallbackClassName="whitespace-pre-wrap"
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
