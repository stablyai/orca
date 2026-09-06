import React from 'react'

import { cn } from '@/lib/utils'
import { WorktreeCardHeader } from './worktree-card-header'
import { WorktreeCardMetaRow } from './worktree-card-meta-row'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import { WorktreeCardPortsDetails } from './WorktreeCardPorts'
import type { WorktreeCardPresentation } from './worktree-card-presentation'
import { WorktreeCardSecondaryRows } from './worktree-card-secondary-rows'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import type { WorktreeCardController } from './use-worktree-card-controller'

export function WorktreeCardParentContent({
  card,
  presentation
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
}): React.JSX.Element {
  const {
    worktree,
    affiliateListMode,
    newCardStyle,
    lineageChildren,
    showStatus,
    unreadTooltip,
    stopQuickActionPointerPropagation,
    handleToggleUnreadQuick,
    statusLaneReview,
    branchIdentityDisplay,
    showInlineAgentList,
    titleRenaming,
    isDeleting,
    hoverIssue,
    hoverLinearIssue,
    hoverJiraIssue,
    hoverReview,
    hoverComment,
    metaAutomationProvenance,
    metaCliProvenance,
    workspacePorts,
    detailsHoverControl,
    handleRenameTitle,
    handleEditIssue,
    handleEditComment,
    handleOpenGitHubIssueInOrca,
    handleOpenIssueInBrowser,
    linearIssue,
    handleOpenLinearIssueInOrca,
    handleOpenReviewInOrca,
    handleOpenReviewInBrowser,
    handleOpenAutomation,
    handleOpenAutomationRun,
    canUnlinkReview,
    handleUnlinkReview
  } = card
  const {
    titleOnlyCard,
    parentContentMarginLeft,
    showCombinedStatusSlot,
    showUnreadQuickAction,
    hasHoverDetails,
    hoverBranchName,
    hoverWorkspaceTitle
  } = presentation

  const identityContent = (
    <div
      className="group/worktree-card flex w-full min-w-0 flex-col gap-1.5"
      data-worktree-card-hover-trigger=""
    >
      <WorktreeCardHeader card={card} presentation={presentation} />
      {presentation.hasMetaRow && <WorktreeCardMetaRow card={card} presentation={presentation} />}
    </div>
  )
  // Why: status glyphs and agent rows own their tooltips; only identity content should open the larger details card.
  const identityContentWithHover =
    hasHoverDetails && !titleRenaming ? (
      <WorktreeCardDetailsHover
        issue={hoverIssue}
        linearIssue={hoverLinearIssue}
        jiraIssue={hoverJiraIssue}
        review={hoverReview}
        comment={hoverComment}
        automationProvenance={metaAutomationProvenance}
        cliProvenance={metaCliProvenance}
        branchName={hoverBranchName}
        workspaceTitle={hoverWorkspaceTitle}
        workspaceTitleRenameDisabled={isDeleting || affiliateListMode}
        detailsAfter={
          workspacePorts.length > 0 ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null
        }
        openDelay={100}
        hoverControl={detailsHoverControl}
        onRenameWorkspaceTitle={affiliateListMode ? undefined : handleRenameTitle}
        onEditIssue={affiliateListMode ? undefined : handleEditIssue}
        onEditComment={affiliateListMode ? undefined : handleEditComment}
        onOpenGitHubIssueInOrca={
          hoverIssue && 'url' in hoverIssue && hoverIssue.url
            ? handleOpenGitHubIssueInOrca
            : undefined
        }
        onOpenIssueInBrowser={
          hoverIssue && 'url' in hoverIssue && hoverIssue.url ? handleOpenIssueInBrowser : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          hoverReview?.url && hoverReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
        onOpenReviewInBrowser={hoverReview?.url ? handleOpenReviewInBrowser : undefined}
        onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
        onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
        onUnlinkReview={!affiliateListMode && canUnlinkReview ? handleUnlinkReview : undefined}
      >
        {identityContent}
      </WorktreeCardDetailsHover>
    ) : (
      identityContent
    )

  return (
    <div
      className={cn(
        'flex w-full min-w-0 gap-0.5 pl-0',
        titleOnlyCard ? 'items-center' : 'items-start'
      )}
      style={
        parentContentMarginLeft < 0 ? { marginLeft: `${parentContentMarginLeft}px` } : undefined
      }
      data-worktree-card-parent-content=""
    >
      {showCombinedStatusSlot ? (
        <div
          className={cn(
            'flex shrink-0 justify-center',
            newCardStyle ? 'mr-1 w-5 items-center' : 'items-start pt-[2px]',
            affiliateListMode && 'px-1'
          )}
          data-worktree-card-status-slot=""
        >
          <WorktreeCardStatusSlot
            worktreeId={worktree.id}
            showStatus={showStatus}
            showUnreadAction={showUnreadQuickAction}
            isUnread={worktree.isUnread}
            unreadTooltip={unreadTooltip}
            onPointerDown={stopQuickActionPointerPropagation}
            onToggleUnread={handleToggleUnreadQuick}
            prDisplay={statusLaneReview}
            newCardStyle={newCardStyle}
            hasBranchIdentity={Boolean(branchIdentityDisplay)}
          />
        </div>
      ) : null}

      {/* Content area */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5',
          // Why: inline agent rows intentionally outdent into the card gutter; inner elements handle truncation.
          showInlineAgentList || (!newCardStyle && lineageChildren)
            ? 'overflow-visible'
            : 'overflow-hidden'
        )}
      >
        {identityContentWithHover}
        <WorktreeCardSecondaryRows card={card} presentation={presentation} />
      </div>
    </div>
  )
}
