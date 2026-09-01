import React from 'react'

import { WorktreeCardSurface } from './worktree-card-surface'
import { WorktreeCardBackgroundLaunchFailures } from './WorktreeCardBackgroundLaunchFailures'
import type { WorktreeCardProps } from './worktree-card-model'
import { useWorktreeCardController } from './use-worktree-card-controller'

export { shouldBeginWorktreeRename } from './worktree-card-model'
export type { ActiveSurfaceVariant } from './worktree-card-model'

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
  onImmediateActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onAssignWorkspaceStatus,
  onCardDragStart,
  onCardDragEnd,
  nativeDragEnabled = true,
  hideRepoBadge,
  hostContextLabel,
  inPinnedSection = false,
  activationRowKey,
  renameRowKey,
  contentIndent = 0,
  flushSurface = false,
  lineageChildCount = 0,
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
    onImmediateActivate,
    onSelectionGesture,
    onContextMenuSelect,
    onAssignWorkspaceStatus,
    onCardDragStart,
    onCardDragEnd,
    nativeDragEnabled,
    hideRepoBadge,
    hostContextLabel,
    inPinnedSection,
    activationRowKey,
    renameRowKey,
    contentIndent,
    flushSurface,
    lineageChildCount,
    lineageCollapsed,
    lineageChildren,
    lineageChildrenStyle,
    onLineageToggle,
    isLineageDropTarget,
    affiliateListMode,
    statusPrDisplay
  })

  return (
    <>
      <WorktreeCardSurface card={card} />
      <WorktreeCardBackgroundLaunchFailures
        worktreeId={worktree.id}
        executionHostId={worktree.hostId ?? 'local'}
      />
    </>
  )
})

export default WorktreeCard
