import React from 'react'
import { useComposedRefs } from 'radix-ui/internal'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import { WorktreeCardMetaBadges } from '../metadata/WorktreeCardMetaBadges'
import { WorktreeCardPortsDetails, WorktreeCardPortsTrigger } from './WorktreeCardPorts'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { WorktreeCardLineActivity } from './worktree-card-line-activity'

/** Ports and linked-item badges; the new card style leaves the review to the status lane.
 *  Why an element, not a component: hover triggers merge their props onto this exact div. */
export function renderWorktreeCardIndicators(
  card: WorktreeCardController
): React.ReactElement | null {
  const { worktree, hasDetails, showPR, showIssue, reviewInStatusLane, compactLine } = card
  // A bot's worker line has no room for ports or branch/PR marks; its hover card lists them.
  const hasPorts = card.hasPorts && !compactLine
  if (!hasDetails && !hasPorts) {
    return null
  }
  const allReferenceItems = getWorkspaceAttachments(worktree)
  const referenceItems = allReferenceItems.filter((item) =>
    item.type !== 'issue'
      ? showPR &&
        !compactLine &&
        (!reviewInStatusLane ||
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
          review={reviewInStatusLane || compactLine ? null : card.metaReview}
          comment={card.metaComment}
          automationProvenance={card.metaAutomationProvenance}
          cliProvenance={card.metaCliProvenance}
          bot={card.metaBot}
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
      bot={card.metaBot}
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
  closed = false,
  children
}: {
  card: WorktreeCardController
  branchName: string | undefined
  workspaceTitle: string | undefined
  /** Keeps the hover card shut, e.g. while the title is being renamed, without unmounting the title. */
  closed?: boolean
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
      bot={card.metaBot}
      branchName={branchName}
      workspaceTitle={workspaceTitle}
      workspaceTitleRenameDisabled={card.isDeleting || affiliateListMode}
      detailsAfter={
        card.compactLine || workspacePorts.length > 0 ? (
          <>
            {card.compactLine ? <WorktreeCardLineActivity worktreeId={worktree.id} /> : null}
            {workspacePorts.length > 0 ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
          </>
        ) : null
      }
      openDelay={100}
      hoverControl={{
        ...hoverControl,
        hoverOpen: hoverControl.hoverOpen && !closed,
        handleHoverOpenChange: (open) => {
          if (open && closed) {
            return
          }
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
