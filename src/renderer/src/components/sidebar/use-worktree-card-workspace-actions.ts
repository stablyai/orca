import { draggedWorktreeCopiesOf } from './worktree-list/drag/dragged-worktree-copies'
import React, { useCallback } from 'react'

import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { runWorktreeDelete } from './delete-worktree-flow'
import { deleteFolderWorkspaceUnlessUnsaved } from './folder-workspace-delete'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import type { ResolvedWorktreeCardProps } from './worktree-card-model'
import { writeWorkspaceDragData } from './workspace-status'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import type { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'
import type { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type LinkedDetails = ReturnType<typeof useWorktreeCardLinkedDetails>
type ReviewDetails = ReturnType<typeof useWorktreeCardReviewDetails>

export function useWorktreeCardWorkspaceActions({
  worktree,
  lineageChildCount,
  lineageCollapsed,
  onLineageToggle,
  isMultiSelected,
  selectedWorktrees,
  onCardDragStart,
  onCardDragEnd,
  onContextMenuSelect,
  folderWorkspaceId,
  setShowRenameErrorDialog,
  isDeleting,
  showDeleteQuickAction
}: Pick<
  ResolvedWorktreeCardProps,
  | 'worktree'
  | 'lineageChildCount'
  | 'lineageCollapsed'
  | 'onLineageToggle'
  | 'isMultiSelected'
  | 'selectedWorktrees'
  | 'onCardDragStart'
  | 'onCardDragEnd'
  | 'onContextMenuSelect'
> &
  Pick<Foundation, 'setShowRenameErrorDialog'> &
  Pick<LinkedDetails, 'isDeleting'> &
  Pick<ReviewDetails, 'folderWorkspaceId'> & {
    showDeleteQuickAction: boolean
  }) {
  const handleWorkspaceQuickAction = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (showDeleteQuickAction) {
        if (folderWorkspaceId) {
          void deleteFolderWorkspaceUnlessUnsaved(
            useAppStore.getState,
            folderWorkspaceId,
            worktree.hostId
          )
          return
        }
        // Qualify deletion with the row’s host so a twin with the same repo/path ID cannot be removed.
        runWorktreeDelete(worktree.id, worktree.hostId ? { expectedHostId: worktree.hostId } : {})
      }
    },
    [folderWorkspaceId, worktree.hostId, showDeleteQuickAction, worktree.id]
  )
  const handleOpenRenameErrorDialog = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setShowRenameErrorDialog(true)
    },
    [setShowRenameErrorDialog]
  )
  const unreadTooltip = worktree.isUnread
    ? translate('auto.components.sidebar.useWorktreeCardWorkspaceActions.markRead', 'Mark read')
    : translate('auto.components.sidebar.useWorktreeCardWorkspaceActions.markUnread', 'Mark unread')
  const lineageChildAriaLabel =
    lineageChildCount === 1
      ? lineageCollapsed
        ? translate(
            'auto.components.sidebar.WorktreeList.showChildWorkspaces_one',
            'Show {{count}} child workspace',
            { count: lineageChildCount }
          )
        : translate(
            'auto.components.sidebar.WorktreeList.hideChildWorkspaces_one',
            'Hide {{count}} child workspace',
            { count: lineageChildCount }
          )
      : lineageCollapsed
        ? translate(
            'auto.components.sidebar.WorktreeList.showChildWorkspaces_other',
            'Show {{count}} child workspaces',
            { count: lineageChildCount }
          )
        : translate(
            'auto.components.sidebar.WorktreeList.hideChildWorkspaces_other',
            'Hide {{count}} child workspaces',
            { count: lineageChildCount }
          )
  const childWorkspaceShortLabel =
    lineageChildCount === 1
      ? translate('auto.components.sidebar.WorktreeList.childCount_one', '{{count}} child', {
          count: lineageChildCount
        })
      : translate('auto.components.sidebar.WorktreeList.childCount_other', '{{count}} children', {
          count: lineageChildCount
        })
  const showLineageChildChip = lineageChildCount > 0 && onLineageToggle !== undefined

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        event.preventDefault()
        return
      }
      if (isDeleting) {
        event.preventDefault()
        return
      }
      const draggedCopies = draggedWorktreeCopiesOf(
        worktree,
        selectedWorktrees,
        Boolean(isMultiSelected && selectedWorktrees && selectedWorktrees.length > 1)
      )
      writeWorkspaceDragData(
        event.dataTransfer,
        draggedCopies.map((copy) => copy.id)
      )
      onCardDragStart?.(event, worktree.id, draggedCopies)
    },
    [isDeleting, isMultiSelected, onCardDragStart, selectedWorktrees, worktree]
  )

  const handleDragEnd = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      onCardDragEnd?.(event)
    },
    [onCardDragEnd]
  )

  const handleContextMenuSelect = useCallback(
    (event: React.MouseEvent<HTMLElement>) => onContextMenuSelect?.(event, worktree) ?? [worktree],
    [onContextMenuSelect, worktree]
  )

  const stopQuickActionPointerPropagation = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      // Why: document-level pointer handling dismisses the Kanban board; quick actions must not count as card activation.
      event.stopPropagation()
    },
    []
  )

  return {
    handleWorkspaceQuickAction,
    handleOpenRenameErrorDialog,
    unreadTooltip,
    lineageChildAriaLabel,
    childWorkspaceShortLabel,
    showLineageChildChip,
    handleDragStart,
    handleDragEnd,
    handleContextMenuSelect,
    stopQuickActionPointerPropagation
  }
}
