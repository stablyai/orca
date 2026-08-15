import React, { useCallback } from 'react'

import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import type { WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import type { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type LinkedDetails = ReturnType<typeof useWorktreeCardLinkedDetails>

export function useWorktreeCardActivationActions({
  worktree,
  repo,
  affiliateListMode,
  onSelectionGesture,
  isActive,
  activationRowKey,
  onActivate,
  onImmediateActivate,
  isDeleting,
  isSshDisconnected,
  updateWorktreeMeta,
  openModal
}: Pick<
  WorktreeCardProps,
  | 'worktree'
  | 'repo'
  | 'affiliateListMode'
  | 'onSelectionGesture'
  | 'isActive'
  | 'activationRowKey'
  | 'onActivate'
  | 'onImmediateActivate'
> &
  Pick<Foundation, 'isSshDisconnected' | 'updateWorktreeMeta' | 'openModal'> &
  Pick<LinkedDetails, 'isDeleting'>) {
  // Stable click handler – ignore clicks that are really text selections.
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      const selection = window.getSelection()
      // Why: only suppress the click for a selection inside this card; a foreign selection must not block worktree switching.
      if (selection && selection.toString().length > 0) {
        const card = event.currentTarget
        const anchor = selection.anchorNode
        const focus = selection.focusNode
        const selectionInsideCard =
          (anchor instanceof Node && card.contains(anchor)) ||
          (focus instanceof Node && card.contains(focus))
        if (selectionInsideCard) {
          return
        }
      }
      const selectionOnly = affiliateListMode
        ? false
        : (onSelectionGesture?.(event, worktree.id) ?? false)
      if (selectionOnly) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (isDeleting) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // Why: route sidebar clicks through the shared activation path so the back/forward stack stays complete.
      recordRendererCrashBreadcrumb('sidebar_worktree_activate', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        wasActive: isActive,
        sshDisconnected: isSshDisconnected
      })
      onImmediateActivate?.(worktree.id, activationRowKey)
      void activateWorktreeFromSidebar(
        worktree.id,
        worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
      )
      onActivate?.()
    },
    [
      affiliateListMode,
      worktree.id,
      worktree.repoId,
      worktree.hostId,
      repo,
      isActive,
      isDeleting,
      activationRowKey,
      isSshDisconnected,
      onActivate,
      onImmediateActivate,
      onSelectionGesture
    ]
  )

  const handleRenameTitle = useCallback(
    // Inline rename has no surface for the failure; the store already logs and
    // refetches, which reverts the optimistic title in place.
    async (displayName: string): Promise<void> => {
      await updateWorktreeMeta(worktree.id, { displayName })
    },
    [updateWorktreeMeta, worktree.id]
  )

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (affiliateListMode) {
        return
      }
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      openModal('edit-meta', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment
      })
    },
    [
      openModal,
      affiliateListMode,
      worktree.comment,
      worktree.displayName,
      worktree.id,
      worktree.linkedIssue,
      worktree.linkedPR,
      worktree.repoId
    ]
  )

  const handleToggleUnreadQuick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
    },
    [worktree.id, worktree.isUnread, updateWorktreeMeta]
  )

  return { handleClick, handleRenameTitle, handleDoubleClick, handleToggleUnreadQuick }
}
