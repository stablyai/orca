import React from 'react'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'

import { getWorktreeCardFrameGeometry } from './worktree-card-frame-geometry'
import '../details/WorktreeCardMeta'
import { hasWorktreeCardDetails } from '../metadata/WorktreeCardMetaBadges'
import {
  renderWorktreeCardIndicators,
  WorktreeCardMetaDetailsHover
} from '../details/worktree-card-details-items'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'

function getVisibleContextLabel(
  projectLabel: string | undefined,
  hostLabel: string | undefined,
  showHost: boolean
): string | undefined {
  const labels = [projectLabel, showHost ? hostLabel : undefined].filter(Boolean)
  return labels.length > 0 ? labels.join(' · ') : undefined
}

export function buildWorktreeCardPresentation(card: WorktreeCardController) {
  const {
    worktree,
    repo,
    inPinnedSection,
    hideRepoBadge,
    hostContextLabel,
    showProjectName,
    affiliateListMode,
    flushSurface,
    contentIndent,
    newCardStyle,
    worktreeCardStyle,
    compactCards,
    isFolder,
    detachedHeadDisplay,
    branch,
    identityDisplay,
    folderMetaRowContent,
    showIdentityInNewCard,
    conflictOperation,
    cardProps,
    cardDetails,
    cacheStartedAt,
    hasDetails,
    hasPorts,
    showStatus,
    showInlineAgentList,
    showLineageChildChip,
    remoteBranchConflict,
    visibleCardTitle,
    workspacePorts,
    metaAutomationProvenance,
    metaCliProvenance,
    hoverIssue,
    hoverLinearIssue,
    hoverJiraIssue,
    hoverReview,
    hoverComment,
    showDeleteQuickAction
  } = card

  // Why: pinned trees mix repos, so ordinary rows lead with the project chip; cross-repo children keep the regular project badge.
  const showPinnedRepoIcon = inPinnedSection && !!repo && !showProjectName
  const showInlineRepoBadge =
    cardDetails.repoInTitle && !!repo && !hideRepoBadge && !isFolder && !showPinnedRepoIcon
  const showRepoBadgeInMetaRow =
    !cardDetails.repoInTitle && !!repo && !hideRepoBadge && !showPinnedRepoIcon
  const contextLabel = getVisibleContextLabel(
    undefined,
    hostContextLabel,
    cardProps.includes('host')
  )
  const showHostContextBadge = !!contextLabel && (!compactCards || !!showProjectName)
  const showDetachedHeadInMetaRow = cardDetails.metaRow && !isFolder && detachedHeadDisplay !== null
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
  // Why: without the identity meta row, a compact card keeps a row only for badges and the timer.
  const hasMetaRow = cardDetails.metaRow
    ? hasDetailedMetaRowContent
    : hasMetadataBadge || cacheStartedAt != null
  const showHeaderActions = showTitleRowPrimary || showDeleteQuickAction
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
    (newCardStyle || compactCards) &&
    (getWorkspaceAttachments(worktree).length > 0 ||
      hasWorktreeCardDetails({
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
  const titleWrapper = hasHoverDetails
    ? (title: React.ReactElement): React.ReactElement => title
    : undefined
  // Why: 2.0 moves status to the right-hand slot, so it has no left lane to offset.
  const slotLayout = worktreeCardStyle === 'experimental-2'
  // Why: sidebar rows need a small surface inset while content stays aligned with the pre-inset layout.
  const { cardStyle, parentContentMarginLeft } = getWorktreeCardFrameGeometry({
    flushSurface,
    contentIndent,
    statusLane: newCardStyle && showCombinedStatusSlot && !slotLayout
  })
  const detailsAndPortsContent = renderWorktreeCardIndicators(card)
  const detailsAndPorts =
    detailsAndPortsContent && !newCardStyle && !compactCards ? (
      <WorktreeCardMetaDetailsHover card={card}>
        {detailsAndPortsContent}
      </WorktreeCardMetaDetailsHover>
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
    slotLayout,
    showPinnedRepoIcon,
    showInlineRepoBadge,
    showRepoBadgeInMetaRow,
    showHostContextBadge,
    contextLabel,
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
