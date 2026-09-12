import React from 'react'

import {
  getFlushWorktreeCardPaddingLeft,
  getNewCardStyleParentContentMarginLeft
} from './worktree-list/rows/indentation'
import {
  hasWorktreeCardDetails,
  WorktreeCardDetailsHover,
  WorktreeCardMetaBadges
} from './WorktreeCardMeta'
import { WorktreeCardPortsDetails, WorktreeCardPortsTrigger } from './WorktreeCardPorts'
import type { WorktreeCardController } from './use-worktree-card-controller'

export function buildWorktreeCardPresentation(card: WorktreeCardController) {
  const {
    worktree,
    repo,
    inPinnedSection,
    hideRepoBadge,
    hostContextLabel,
    affiliateListMode,
    flushSurface,
    contentIndent,
    newCardStyle,
    compactCards,
    isFolder,
    detachedHeadDisplay,
    branch,
    identityDisplay,
    folderMetaRowContent,
    showIdentityInNewCard,
    conflictOperation,
    cardProps,
    cacheStartedAt,
    hasDetails,
    hasPorts,
    showStatus,
    showInlineAgentList,
    showLineageChildChip,
    remoteBranchConflict,
    visibleCardTitle,
    workspacePorts,
    metaIssue,
    metaLinearIssue,
    metaJiraIssue,
    metaReview,
    metaComment,
    metaAutomationProvenance,
    metaCliProvenance,
    hoverIssue,
    hoverLinearIssue,
    hoverJiraIssue,
    hoverReview,
    hoverComment,
    linearIssue,
    handleEditIssue,
    handleEditComment,
    handleOpenGitHubIssueInOrca,
    handleOpenIssueInBrowser,
    handleOpenLinearIssueInOrca,
    handleOpenReviewInOrca,
    handleOpenReviewInBrowser,
    handleOpenAutomation,
    handleOpenAutomationRun,
    canUnlinkReview,
    handleUnlinkReview,
    detailsHoverControl,
    showDeleteQuickAction
  } = card

  // Why: pinned trees mix repos, so the repo icon shows regardless of groupBy's hideRepoBadge.
  const showPinnedRepoIcon = inPinnedSection && !!repo
  // Why: new card style retired the Compact/Detailed switch; repo identity uses the compact chip, not a lower pill.
  const showRepoIdentityInTitle = newCardStyle || compactCards
  const showInlineRepoBadge =
    showRepoIdentityInTitle && !!repo && !hideRepoBadge && !isFolder && !showPinnedRepoIcon
  const showRepoBadgeInMetaRow =
    !showRepoIdentityInTitle && !!repo && !hideRepoBadge && !showPinnedRepoIcon
  const showHostContextBadge = !compactCards && !!hostContextLabel
  const showDetachedHeadInMetaRow = !compactCards && !isFolder && detachedHeadDisplay !== null
  const showBranch =
    !isFolder &&
    branch.length > 0 &&
    !newCardStyle &&
    (!compactCards || branch !== worktree.displayName)
  // Why: rebases already surface in source control, so dense cards skip the persistent rebase chip.
  const showConflictOperationBadge =
    !!conflictOperation && conflictOperation !== 'unknown' && conflictOperation !== 'rebase'
  const hasMetadataBadge = showConflictOperationBadge
  const showUnreadQuickAction = !affiliateListMode && showStatus && !newCardStyle
  // Why: the slot owns the unread/status lane; legacy keeps the bell toggle, the new card keeps the glyph passive.
  const showCombinedStatusSlot = showStatus
  const showTitleRowPrimary = compactCards && worktree.isMainWorktree && !isFolder
  const showMetaRowDetails = !newCardStyle && !compactCards && (hasDetails || hasPorts)
  const showTitleRowIndicators = (newCardStyle || compactCards) && (hasDetails || hasPorts)
  // Why: grouped views can hide the repo badge; don't reserve a blank metadata lane unless there's real content.
  const hasDetailedMetaRowContent = Boolean(
    (showRepoBadgeInMetaRow && repo) ||
    showHostContextBadge ||
    folderMetaRowContent ||
    showBranch ||
    showIdentityInNewCard ||
    showDetachedHeadInMetaRow ||
    showConflictOperationBadge ||
    cacheStartedAt != null ||
    showMetaRowDetails
  )
  const hasMetaRow = compactCards
    ? hasMetadataBadge || cacheStartedAt != null
    : hasDetailedMetaRowContent
  const showHeaderActions = showTitleRowPrimary || showDeleteQuickAction
  // Why: normalize the title once so title/branch de-dupe and identity-only hover eligibility stay in sync.
  const trimmedVisibleCardTitle = visibleCardTitle.trim()
  const showBranchIdentityHover = newCardStyle
    ? Boolean(identityDisplay) &&
      !cardProps.includes('branch') &&
      identityDisplay !== trimmedVisibleCardTitle
    : compactCards && showBranch
  const hoverBranchName = newCardStyle
    ? identityDisplay
    : showBranchIdentityHover
      ? branch
      : undefined
  const hoverWorkspaceTitle =
    trimmedVisibleCardTitle.length > 0 && trimmedVisibleCardTitle !== hoverBranchName
      ? trimmedVisibleCardTitle
      : undefined
  const hasHoverIdentity = Boolean(hoverWorkspaceTitle || hoverBranchName)
  const hasHoverDetails =
    newCardStyle &&
    (hasWorktreeCardDetails({
      issue: hoverIssue,
      linearIssue: hoverLinearIssue,
      jiraIssue: hoverJiraIssue,
      review: hoverReview,
      comment: hoverComment,
      automationProvenance: metaAutomationProvenance,
      cliProvenance: metaCliProvenance
    }) ||
      workspacePorts.length > 0 ||
      hasHoverIdentity)
  // Why: the parent row owns metadata hover; don't stack the title's truncation tooltip on the details popover.
  const titleWrapper = newCardStyle
    ? hasHoverDetails
      ? (title: React.ReactElement): React.ReactElement => title
      : undefined
    : compactCards && (showBranchIdentityHover || hasDetails || hasPorts)
      ? (title: React.ReactElement): React.ReactElement => (
          <WorktreeCardDetailsHover
            issue={metaIssue}
            linearIssue={metaLinearIssue}
            jiraIssue={metaJiraIssue}
            review={metaReview}
            comment={metaComment}
            automationProvenance={metaAutomationProvenance}
            cliProvenance={metaCliProvenance}
            branchName={showBranchIdentityHover ? branch : undefined}
            workspaceTitle={worktree.displayName}
            identityOrder="branch-first"
            detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
            openDelay={100}
            // Why: compact mode also renders the plug/badge hover root; sharing one open-state made hovering the
            // plug force-open the wider title card and race it closed (#9304), so let this title hover own its state.
            onEditIssue={affiliateListMode ? undefined : handleEditIssue}
            onEditComment={affiliateListMode ? undefined : handleEditComment}
            onOpenGitHubIssueInOrca={
              metaIssue && 'url' in metaIssue && metaIssue.url
                ? handleOpenGitHubIssueInOrca
                : undefined
            }
            onOpenIssueInBrowser={
              metaIssue && 'url' in metaIssue && metaIssue.url
                ? handleOpenIssueInBrowser
                : undefined
            }
            onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
            onOpenReviewInOrca={
              metaReview?.url && metaReview.provider === 'github'
                ? handleOpenReviewInOrca
                : undefined
            }
            onOpenReviewInBrowser={metaReview?.url ? handleOpenReviewInBrowser : undefined}
            onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
            onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
            // Why: compact mode hides the metadata badge row, so title hover carries the review affordance.
            onUnlinkReview={!affiliateListMode && canUnlinkReview ? handleUnlinkReview : undefined}
          >
            {title}
          </WorktreeCardDetailsHover>
        )
      : undefined
  // Why: sidebar rows need a small surface inset while content stays aligned with the pre-inset layout.
  const applyNewCardStyleStatusLaneOffset = newCardStyle && showCombinedStatusSlot
  const cardPaddingLeft = flushSurface
    ? getFlushWorktreeCardPaddingLeft(contentIndent, applyNewCardStyleStatusLaneOffset)
    : contentIndent > 0
      ? `calc(0.125rem + ${contentIndent}px)`
      : null
  const parentContentMarginLeft =
    flushSurface && applyNewCardStyleStatusLaneOffset
      ? getNewCardStyleParentContentMarginLeft(contentIndent)
      : 0
  const cardStyle = cardPaddingLeft ? { paddingLeft: cardPaddingLeft } : undefined
  const detailsAndPortsContent =
    hasDetails || hasPorts ? (
      <div className="flex shrink-0 items-center gap-1">
        {hasPorts && <WorktreeCardPortsTrigger ports={workspacePorts} />}
        {hasDetails && (
          <WorktreeCardMetaBadges
            issue={metaIssue}
            linearIssue={metaLinearIssue}
            jiraIssue={metaJiraIssue}
            review={newCardStyle ? null : metaReview}
            comment={metaComment}
            automationProvenance={metaAutomationProvenance}
            cliProvenance={metaCliProvenance}
            className="ml-0 pr-0"
          />
        )}
      </div>
    ) : null
  const detailsAndPorts =
    detailsAndPortsContent && !newCardStyle ? (
      <WorktreeCardDetailsHover
        issue={metaIssue}
        linearIssue={metaLinearIssue}
        jiraIssue={metaJiraIssue}
        review={metaReview}
        comment={metaComment}
        automationProvenance={metaAutomationProvenance}
        cliProvenance={metaCliProvenance}
        detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
        hoverControl={detailsHoverControl}
        onEditIssue={affiliateListMode ? undefined : handleEditIssue}
        onEditComment={affiliateListMode ? undefined : handleEditComment}
        onOpenGitHubIssueInOrca={
          metaIssue && 'url' in metaIssue && metaIssue.url ? handleOpenGitHubIssueInOrca : undefined
        }
        onOpenIssueInBrowser={
          metaIssue && 'url' in metaIssue && metaIssue.url ? handleOpenIssueInBrowser : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          metaReview?.url && metaReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
        onOpenReviewInBrowser={metaReview?.url ? handleOpenReviewInBrowser : undefined}
        onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
        onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
        onUnlinkReview={!affiliateListMode && canUnlinkReview ? handleUnlinkReview : undefined}
      >
        {detailsAndPortsContent}
      </WorktreeCardDetailsHover>
    ) : (
      detailsAndPortsContent
    )
  const titleRowIndicators = showTitleRowIndicators ? (
    <div className="ml-auto flex shrink-0 items-center gap-1 pr-1.5">{detailsAndPorts}</div>
  ) : null
  const hasSecondaryCardContent =
    hasMetaRow || !!remoteBranchConflict || showInlineAgentList || showLineageChildChip
  const titleOnlyCard = !hasSecondaryCardContent

  return {
    showPinnedRepoIcon,
    showInlineRepoBadge,
    showRepoBadgeInMetaRow,
    showHostContextBadge,
    showIdentityInNewCard,
    showDetachedHeadInMetaRow,
    showBranch,
    showConflictOperationBadge,
    showUnreadQuickAction,
    showCombinedStatusSlot,
    showTitleRowPrimary,
    showMetaRowDetails,
    showTitleRowIndicators,
    hasMetaRow,
    showHeaderActions,
    showDeleteQuickAction,
    hoverBranchName,
    hoverWorkspaceTitle,
    hasHoverDetails,
    titleWrapper,
    parentContentMarginLeft,
    cardStyle,
    detailsAndPorts,
    titleRowIndicators,
    titleOnlyCard
  }
}

export type WorktreeCardPresentation = ReturnType<typeof buildWorktreeCardPresentation>
