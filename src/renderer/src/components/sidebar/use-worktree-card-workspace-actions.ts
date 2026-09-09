import React, { useCallback } from 'react'

import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { runWorktreeDelete } from './delete-worktree-flow'
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
  deleteFolderWorkspace,
  setActiveWorktree,
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
  Pick<Foundation, 'deleteFolderWorkspace' | 'setActiveWorktree' | 'setShowRenameErrorDialog'> &
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
          void deleteFolderWorkspace(
            folderWorkspaceId,
            worktree.hostId ? { executionHostId: worktree.hostId } : undefined
          ).then((deleted) => {
            if (
              deleted &&
              useAppStore.getState().activeWorktreeId === folderWorkspaceKey(folderWorkspaceId) &&
              (!worktree.hostId ||
                useAppStore.getState().activeWorkspaceExecutionHostId === worktree.hostId)
            ) {
              setActiveWorktree(null)
            }
          })
          return
        }
        // Why the host (STA-4343): this row is one of possibly two for the same
        // `repoId::path`, so it has to name its own or the delete lands on the other.
        runWorktreeDelete(worktree.id, worktree.hostId ? { expectedHostId: worktree.hostId } : {})
      }
    },
    [
      deleteFolderWorkspace,
      folderWorkspaceId,
      worktree.hostId,
      setActiveWorktree,
      showDeleteQuickAction,
      worktree.id
    ]
  )
  const handleOpenRenameErrorDialog = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setShowRenameErrorDialog(true)
    },
    [setShowRenameErrorDialog]
  )
  const unreadTooltip = worktree.isUnread ? 'Mark read' : 'Mark unread'
  const lineageChildAriaLabel =
    lineageChildCount === 1
      ? lineageCollapsed
        ? translate(
            'auto.components.sidebar.WorktreeList.20bebf9c7f',
            'Show {{value0}} child workspace',
            { value0: lineageChildCount }
          )
        : translate(
            'auto.components.sidebar.WorktreeList.e97297cb75',
            'Hide {{value0}} child workspace',
            { value0: lineageChildCount }
          )
      : lineageCollapsed
        ? translate(
            'auto.components.sidebar.WorktreeList.c1f4a31623',
            'Show {{value0}} child workspaces',
            { value0: lineageChildCount }
          )
        : translate(
            'auto.components.sidebar.WorktreeList.0cd15956d4',
            'Hide {{value0}} child workspaces',
            { value0: lineageChildCount }
          )
  const childWorkspaceShortLabel = `${lineageChildCount} ${
    lineageChildCount === 1
      ? translate('auto.components.sidebar.WorktreeList.0c6ee14f23', 'child')
      : translate('auto.components.sidebar.WorktreeList.045a8aed48', 'children')
  }`
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
      const dragIds =
        isMultiSelected && selectedWorktrees && selectedWorktrees.length > 1
          ? selectedWorktrees.map((item) => item.id)
          : worktree.id
      writeWorkspaceDragData(event.dataTransfer, dragIds)
      onCardDragStart?.(event, worktree.id, Array.isArray(dragIds) ? dragIds : [dragIds])
    },
    [isDeleting, isMultiSelected, onCardDragStart, selectedWorktrees, worktree.id]
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
