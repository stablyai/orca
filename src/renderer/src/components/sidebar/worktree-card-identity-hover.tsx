import React from 'react'

import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments/workspace-attachments'
import { WorktreeCardDetailsHover } from './workspace-card/details/WorktreeCardMeta'
import { WorktreeCardPortsDetails } from './workspace-card/details/WorktreeCardPorts'
import type { WorktreeCardPresentation } from './workspace-card/surface/worktree-card-presentation'
import type { WorktreeCardController } from './workspace-card/controller/use-worktree-card-controller'

/** Status glyphs and agent rows own their tooltips; only identity content opens the larger details card. */
export function WorktreeCardIdentityHover({
  card,
  presentation,
  children
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
  children: React.ReactElement
}): React.ReactElement {
  const {
    worktree,
    repo,
    affiliateListMode,
    titleRenaming,
    isDeleting,
    referenceDetails,
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
    handleManageLinks,
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
  const { hasHoverDetails, hoverBranchName, hoverWorkspaceTitle } = presentation
  if (!hasHoverDetails || titleRenaming) {
    return children
  }
  return (
    <WorktreeCardDetailsHover
      workspace={worktree}
      referenceDetails={referenceDetails}
      onManageLinks={affiliateListMode ? undefined : handleManageLinks}
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
      onOpenReviewInOrca={repo ? handleOpenReviewInOrca : undefined}
      onOpenReviewInBrowser={hoverReview?.url ? handleOpenReviewInBrowser : undefined}
      onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
      onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
      onUnlinkReview={
        !affiliateListMode &&
        (canUnlinkReview || getWorkspaceAttachments(worktree).some((item) => item.type !== 'issue'))
          ? handleUnlinkReview
          : undefined
      }
    >
      {children}
    </WorktreeCardDetailsHover>
  )
}
