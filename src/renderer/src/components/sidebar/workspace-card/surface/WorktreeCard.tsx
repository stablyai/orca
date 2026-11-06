import React from 'react'

import { WorktreeCardSurface } from './worktree-card-surface'
import type { WorktreeCardProps } from '../controller/worktree-card-model'
import { useWorktreeCardController } from '../controller/use-worktree-card-controller'

import '../controller/worktree-card-model'

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  isActiveSurface = isActive,
  activeSurfaceVariant = 'primary',
  isMultiSelected = false,
  revealHighlight = false,
  revealHighlightTone = 'default',
  selectedWorktrees,
  onActivate,
  onWorktreeCardClick,
  onImmediateActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onAssignWorkspaceStatus,
  onCardDragStart,
  onCardDragEnd,
  nativeDragEnabled = true,
  hideRepoBadge,
  hostContextLabel,
  showProjectName,
  inPinnedSection = false,
  activationRowKey,
  renameRowKey,
  contentIndent = 0,
  flushSurface = false,
  lineageChildCount = 0,
  lineageChildWorktreeIds,
  lineageCollapsed = false,
  lineageChildren,
  lineageChildrenStyle,
  onLineageToggle,
  isLineageDropTarget = false,
  affiliateListMode = false,
  statusPrDisplay = null
}: WorktreeCardProps): React.JSX.Element {
  const card = useWorktreeCardController({
    worktree,
    repo,
    isActive,
    isActiveSurface,
    activeSurfaceVariant,
    isMultiSelected,
    revealHighlight,
    revealHighlightTone,
    selectedWorktrees,
    onActivate,
    onWorktreeCardClick,
    onImmediateActivate,
    onSelectionGesture,
    onContextMenuSelect,
    onAssignWorkspaceStatus,
    onCardDragStart,
    onCardDragEnd,
    nativeDragEnabled,
    hideRepoBadge,
    hostContextLabel,
    showProjectName,
    inPinnedSection,
    activationRowKey,
    renameRowKey,
    contentIndent,
    flushSurface,
    lineageChildCount,
    lineageChildWorktreeIds,
    lineageCollapsed,
    lineageChildren,
    lineageChildrenStyle,
    onLineageToggle,
    isLineageDropTarget,
    affiliateListMode,
    statusPrDisplay
  })

  return <WorktreeCardSurface card={card} />
})

export default WorktreeCard
