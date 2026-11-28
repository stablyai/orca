import React from 'react'
import { Pencil, StickyNote } from 'lucide-react'
import { HoverCardContent } from '@/components/ui/hover-card'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { SelectedTextCopyMenu } from '@/components/clipboard/SelectedTextCopyMenu'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useTranslate } from '@/i18n/use-translate'
import { WORKTREE_NATIVE_CONTEXT_MENU_ATTR } from '../../workspace-actions/context-menu/worktree-context-menu-policy'
import { useWorkspaceReferenceLinkActions } from '../review/use-workspace-reference-link-actions'
import { WorktreeCardLinkedItemsSection } from '../review/WorktreeCardLinkedItemsSection'
import { WorktreeCardLinkedReviewActions } from '../review/WorktreeCardReviewActions'
import { WorktreeCardReviewDetailSection } from '../review/WorktreeCardReviewDetailSection'
import { WorktreeCardTaskDetailSection } from '../review/WorktreeCardTaskDetailSection'
import { getWorktreeCardTaskActions } from '../review/worktree-card-task-actions'
import { DetailHeader, MetadataActionIcon } from '../metadata/WorktreeCardMetadataControls'
import { hasComment } from '../metadata/WorktreeCardMetaBadges'
import type { WorktreeCardDetailsHoverProps } from '../metadata/worktree-card-meta-types'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { WorktreeCardAutomationDetailSection } from './WorktreeCardAutomationDetailSection'
import { WorktreeCardOriginDetailSections } from './WorktreeCardBotDetailSection'
import { WorktreeCardHoverIdentityHeader } from './WorktreeCardHoverIdentityHeader'
import type { WorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { CommentMarkdownAsync } from '../../../comment-markdown/comment-markdown-lazy'

const LazyWorktreeCardAutoNameFailureSection = lazyWithRetry(
  () =>
    import('./WorktreeCardAutoNameFailureSection').then((module) => ({
      default: module.WorktreeCardAutoNameFailureSection
    })),
  { reloadKey: 'worktree-card-auto-name-failure-section' }
)

const COMMENT_MARKDOWN_CLASS_NAME =
  'text-[11.5px] text-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1'

export type WorktreeCardHoverContentProps = Omit<
  WorktreeCardDetailsHoverProps,
  'children' | 'openDelay' | 'closeDelay' | 'onWorkspaceTitleEditingChange' | 'hoverControl'
> & {
  detailsHoverControl: WorktreeCardDetailsHoverControl
  showIdentityHeader: boolean
  showAttachmentCollection: boolean
  onWorkspaceTitleEditingChange: (editing: boolean) => void
}

export function WorktreeCardHoverContent({
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
  bot,
  branchName,
  workspaceTitle,
  identityOrder = 'workspace-first',
  workspaceTitleRenameDisabled = false,
  autoNameFailure,
  detailsAfter,
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
  detailsHoverControl,
  showIdentityHeader,
  showAttachmentCollection
}: WorktreeCardHoverContentProps): React.JSX.Element {
  const t = useTranslate()
  const { reviewMenuOpen, handleIssueMenuOpenChange, handleReviewMenuOpenChange, closeHover } =
    detailsHoverControl
  const { linkActionPopoverProps, onOpenLink, onAuxClickCapture } =
    useWorkspaceReferenceLinkActions(workspace?.id, detailsHoverControl)

  const dismissAndRun = React.useCallback(
    (handler: ((event: React.MouseEvent) => void) | undefined) => (event: React.MouseEvent) => {
      closeHover()
      handler?.(event)
    },
    [closeHover]
  )

  const taskActions = getWorktreeCardTaskActions(closeHover, {
    onEditIssue,
    onOpenGitHubIssueInOrca,
    onOpenIssueInBrowser,
    onOpenLinearIssueInOrca
  })

  return (
    <>
      <span className="contents" onClick={(event) => event.stopPropagation()}>
        <LinkActionPopover {...linkActionPopoverProps} />
      </span>
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
              onWorkspaceTitleEditingChange={onWorkspaceTitleEditingChange}
            />
          )}

          {autoNameFailure ? (
            <React.Suspense fallback={null}>
              <LazyWorktreeCardAutoNameFailureSection failure={autoNameFailure} />
            </React.Suspense>
          ) : null}

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
                actions={taskActions}
                onMenuOpenChange={handleIssueMenuOpenChange}
                onOpenLink={onOpenLink}
                onManageLinks={onManageLinks ? dismissAndRun(onManageLinks) : undefined}
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
            taskMenu={{ actions: taskActions, onOpenChange: handleIssueMenuOpenChange }}
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

          <WorktreeCardOriginDetailSections bot={bot} cliProvenance={cliProvenance} />

          {hasComment(comment) && (
            <WorktreeCardDetailSection>
              <DetailHeader
                icon={<StickyNote className="size-3 text-muted-foreground" />}
                label={t('auto.components.sidebar.WorktreeCardMeta.93cbea12c2', 'Notes')}
                actions={
                  onEditComment ? (
                    <MetadataActionIcon
                      label={t('auto.components.sidebar.WorktreeCardMeta.c7fa72ead0', 'Edit notes')}
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
    </>
  )
}
