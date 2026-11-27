import React from 'react'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { HoverCard, HoverCardTrigger } from '@/components/ui/hover-card'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import '../../workspace-actions/context-menu/WorktreeContextMenu'
import { hasComment, hasWorktreeCardDetails } from '../metadata/WorktreeCardMetaBadges'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import type { WorktreeCardDetailsHoverProps } from '../metadata/worktree-card-meta-types'
import { preloadCommentMarkdown } from '../../../comment-markdown/comment-markdown-lazy'
import { useActivityThreadHoverCardIntent } from '@/components/activity/thread-preview/activity-thread-hover-card-intent'
import type * as WorktreeCardHoverContentModule from './WorktreeCardHoverContent'

const loadWorktreeCardHoverContent = (): Promise<typeof WorktreeCardHoverContentModule> =>
  import('./WorktreeCardHoverContent')

const LazyWorktreeCardHoverContent = lazyWithRetry(
  () =>
    loadWorktreeCardHoverContent().then((module) => ({
      default: module.WorktreeCardHoverContent
    })),
  { reloadKey: 'worktree-card-hover-content' }
)

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
  bot,
  children,
  branchName,
  workspaceTitle,
  identityOrder = 'workspace-first',
  workspaceTitleRenameDisabled = false,
  autoNameFailure,
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
  const { hoverOpen, contextMenuOpen, handleHoverOpenChange } = detailsHoverControl
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
  // Same rest-to-peek intent as agent activity rows so passing pointers don't flash the card.
  const hoverIntent = useActivityThreadHoverCardIntent({
    open: hoverOpen || workspaceTitleEditing,
    onOpenChange: handleEffectiveHoverOpenChange,
    openDelay
  })
  const showIdentityHeader = Boolean(branchName || workspaceTitle)
  const attachments = getWorkspaceAttachments(workspace ?? {})
  const showAttachmentCollection =
    attachments.length > 1 ||
    (attachments.length === 1 && !issue && !linearIssue && !jiraIssue && !review)
  const effectiveOpen = workspaceTitleEditing || (!contextMenuOpen && hoverOpen)
  const hasOpenedHover = useLatchedOpen(effectiveOpen)

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
      cliProvenance,
      bot
    }) &&
    !autoNameFailure &&
    !detailsAfter
  ) {
    return children
  }

  return (
    <HoverCard
      open={effectiveOpen}
      onOpenChange={hoverIntent.onOpenChange}
      openDelay={0}
      closeDelay={closeDelay}
    >
      <HoverCardTrigger
        asChild
        {...hoverIntent.triggerHandlers}
        onPointerEnter={(event) => {
          hoverIntent.triggerHandlers.onPointerEnter(event)
          void loadWorktreeCardHoverContent().catch(() => {})
          if (hasComment(comment)) {
            preloadCommentMarkdown()
          }
        }}
      >
        {children}
      </HoverCardTrigger>
      {hasOpenedHover ? (
        <React.Suspense fallback={null}>
          <LazyWorktreeCardHoverContent
            workspace={workspace}
            referenceDetails={referenceDetails}
            onManageLinks={onManageLinks}
            issue={issue}
            linearIssue={linearIssue}
            jiraIssue={jiraIssue}
            review={review}
            comment={comment}
            automationProvenance={automationProvenance}
            cliProvenance={cliProvenance}
            bot={bot}
            branchName={branchName}
            workspaceTitle={workspaceTitle}
            identityOrder={identityOrder}
            workspaceTitleRenameDisabled={workspaceTitleRenameDisabled}
            autoNameFailure={autoNameFailure}
            detailsAfter={detailsAfter}
            onRenameWorkspaceTitle={onRenameWorkspaceTitle}
            onWorkspaceTitleEditingChange={handleWorkspaceTitleEditingChange}
            onEditIssue={onEditIssue}
            onEditComment={onEditComment}
            onOpenGitHubIssueInOrca={onOpenGitHubIssueInOrca}
            onOpenIssueInBrowser={onOpenIssueInBrowser}
            onOpenLinearIssueInOrca={onOpenLinearIssueInOrca}
            onOpenReviewInOrca={onOpenReviewInOrca}
            onUnlinkReview={onUnlinkReview}
            onOpenAutomation={onOpenAutomation}
            onOpenAutomationRun={onOpenAutomationRun}
            detailsHoverControl={detailsHoverControl}
            showIdentityHeader={showIdentityHeader}
            showAttachmentCollection={showAttachmentCollection}
          />
        </React.Suspense>
      ) : null}
    </HoverCard>
  )
}
