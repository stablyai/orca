import React from 'react'
import { useComposedRefs } from 'radix-ui/internal'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import { WorktreeCardMetaBadges } from '../metadata/WorktreeCardMetaBadges'
import { WorktreeCardPortsDetails, WorktreeCardPortsTrigger } from './WorktreeCardPorts'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'

/** Ports and linked-item badges; the new card style leaves the review to the status lane.
 *  Why an element, not a component: hover triggers merge their props onto this exact div. */
export function renderWorktreeCardIndicators(
  card: WorktreeCardController
): React.ReactElement | null {
  const { worktree, hasDetails, hasPorts, showPR, showIssue } = card
  // 1.0 draws the PR in its status lane; 2.0 has no lane, so it lists the PR like Classic.
  const newCardStyle = card.newCardStyle && card.worktreeCardStyle !== 'experimental-2'
  if (!hasDetails && !hasPorts) {
    return null
  }
  const allReferenceItems = getWorkspaceAttachments(worktree)
  const referenceItems = allReferenceItems.filter((item) =>
    item.type !== 'issue'
      ? showPR &&
        (!newCardStyle ||
          allReferenceItems.filter((candidate) => candidate.type !== 'issue').length > 1)
      : item.provider === 'linear'
        ? card.showLinearIssue
        : item.provider === 'jira'
          ? card.showJiraIssue
          : showIssue
  )
  return (
    <div className="flex shrink-0 items-center gap-1">
      {hasPorts && <WorktreeCardPortsTrigger ports={card.workspacePorts} />}
      {hasDetails && (
        <WorktreeCardMetaBadges
          linkedItemCount={allReferenceItems.length}
          referenceItems={referenceItems}
          referenceDetails={card.referenceDetails}
          issue={card.metaIssue}
          linearIssue={card.metaLinearIssue}
          jiraIssue={card.metaJiraIssue}
          review={newCardStyle ? null : card.metaReview}
          comment={card.metaComment}
          automationProvenance={card.metaAutomationProvenance}
          cliProvenance={card.metaCliProvenance}
          className="ml-0 pr-0"
        />
      )}
    </div>
  )
}

function canUnlink(card: WorktreeCardController): boolean {
  return (
    !card.affiliateListMode &&
    (card.canUnlinkReview ||
      getWorkspaceAttachments(card.worktree).some((item) => item.type !== 'issue'))
  )
}

/** The classic card's hover over its meta-row badges. */
export function WorktreeCardMetaDetailsHover({
  card,
  children
}: {
  card: WorktreeCardController
  children: React.ReactElement
}): React.JSX.Element {
  const { worktree, repo, affiliateListMode, metaIssue, metaReview, workspacePorts } = card
  return (
    <WorktreeCardDetailsHover
      workspace={worktree}
      referenceDetails={card.referenceDetails}
      onManageLinks={affiliateListMode ? undefined : card.handleManageLinks}
      issue={metaIssue}
      linearIssue={card.metaLinearIssue}
      jiraIssue={card.metaJiraIssue}
      review={metaReview}
      comment={card.metaComment}
      automationProvenance={card.metaAutomationProvenance}
      cliProvenance={card.metaCliProvenance}
      detailsAfter={card.hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
      hoverControl={card.detailsHoverControl}
      onEditIssue={affiliateListMode ? undefined : card.handleEditIssue}
      onEditComment={affiliateListMode ? undefined : card.handleEditComment}
      onOpenGitHubIssueInOrca={
        metaIssue && 'url' in metaIssue && metaIssue.url
          ? card.handleOpenGitHubIssueInOrca
          : undefined
      }
      onOpenIssueInBrowser={
        metaIssue && 'url' in metaIssue && metaIssue.url ? card.handleOpenIssueInBrowser : undefined
      }
      onOpenLinearIssueInOrca={card.linearIssue?.url ? card.handleOpenLinearIssueInOrca : undefined}
      onOpenReviewInOrca={repo ? card.handleOpenReviewInOrca : undefined}
      onOpenReviewInBrowser={metaReview?.url ? card.handleOpenReviewInBrowser : undefined}
      onOpenAutomation={affiliateListMode ? undefined : card.handleOpenAutomation}
      onOpenAutomationRun={affiliateListMode ? undefined : card.handleOpenAutomationRun}
      onUnlinkReview={canUnlink(card) ? card.handleUnlinkReview : undefined}
    >
      {children}
    </WorktreeCardDetailsHover>
  )
}

/** The hover card over a card's identity (title and meta row). */
export function WorktreeCardIdentityHover({
  card,
  branchName,
  workspaceTitle,
  children
}: {
  card: WorktreeCardController
  branchName: string | undefined
  workspaceTitle: string | undefined
  children: React.ReactElement<React.RefAttributes<HTMLElement>>
}): React.JSX.Element {
  const { worktree, repo, affiliateListMode, hoverIssue, hoverReview, workspacePorts } = card
  const identityRef = React.useRef<HTMLElement>(null)
  const ref = useComposedRefs(children.props.ref, identityRef)
  const hoverControl = card.detailsHoverControl
  return (
    <WorktreeCardDetailsHover
      workspace={worktree}
      referenceDetails={card.referenceDetails}
      onManageLinks={affiliateListMode ? undefined : card.handleManageLinks}
      issue={hoverIssue}
      linearIssue={card.hoverLinearIssue}
      jiraIssue={card.hoverJiraIssue}
      review={hoverReview}
      comment={card.hoverComment}
      automationProvenance={card.metaAutomationProvenance}
      cliProvenance={card.metaCliProvenance}
      branchName={branchName}
      workspaceTitle={workspaceTitle}
      workspaceTitleRenameDisabled={card.isDeleting || affiliateListMode}
      detailsAfter={
        workspacePorts.length > 0 ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null
      }
      openDelay={100}
      hoverControl={{
        ...hoverControl,
        handleHoverOpenChange: (open) => {
          if (
            !open ||
            !identityRef.current?.querySelector(
              '[data-worktree-card-identity-indicator]:hover, [data-worktree-card-identity-indicator]:focus-visible'
            )
          ) {
            hoverControl.handleHoverOpenChange(open)
          }
        }
      }}
      onRenameWorkspaceTitle={affiliateListMode ? undefined : card.handleRenameTitle}
      onEditIssue={affiliateListMode ? undefined : card.handleEditIssue}
      onEditComment={affiliateListMode ? undefined : card.handleEditComment}
      onOpenGitHubIssueInOrca={
        hoverIssue && 'url' in hoverIssue && hoverIssue.url
          ? card.handleOpenGitHubIssueInOrca
          : undefined
      }
      onOpenIssueInBrowser={
        hoverIssue && 'url' in hoverIssue && hoverIssue.url
          ? card.handleOpenIssueInBrowser
          : undefined
      }
      onOpenLinearIssueInOrca={card.linearIssue?.url ? card.handleOpenLinearIssueInOrca : undefined}
      onOpenReviewInOrca={repo ? card.handleOpenReviewInOrca : undefined}
      onOpenReviewInBrowser={hoverReview?.url ? card.handleOpenReviewInBrowser : undefined}
      onOpenAutomation={affiliateListMode ? undefined : card.handleOpenAutomation}
      onOpenAutomationRun={affiliateListMode ? undefined : card.handleOpenAutomationRun}
      onUnlinkReview={canUnlink(card) ? card.handleUnlinkReview : undefined}
    >
      {React.cloneElement(children, { ref })}
    </WorktreeCardDetailsHover>
  )
}
