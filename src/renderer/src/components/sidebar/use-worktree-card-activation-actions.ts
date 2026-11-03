import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import {
  noteWorktreeRowHoverEnd,
  noteWorktreeRowHoverStart,
  noteWorktreeRowPress
} from './worktree-row-hover-prewarm'
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
  onWorktreeCardClick,
  onImmediateActivate,
  isDeleting,
  isSshDisconnected,
  updateWorktreeMeta,
  setWorkspaceUnreadByUser,
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
  | 'onWorktreeCardClick'
  | 'onImmediateActivate'
> &
  Pick<
    Foundation,
    'isSshDisconnected' | 'updateWorktreeMeta' | 'setWorkspaceUnreadByUser' | 'openModal'
  > &
  Pick<LinkedDetails, 'isDeleting'>) {
  const worktreeRef = useRef(worktree)
  useLayoutEffect(() => {
    worktreeRef.current = worktree
  }, [worktree])
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
        : (onSelectionGesture?.(event, worktreeRef.current) ?? false)
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
      onWorktreeCardClick?.()
      // Use shared activation so sidebar navigation participates in back/forward history.
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
      onWorktreeCardClick,
      onImmediateActivate,
      onSelectionGesture
    ]
  )

  const handlePointerEnter = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Touch and pen have no hover intent; a disconnected SSH host cannot reattach a PTY.
      if (event.pointerType !== 'mouse' || isActive || isDeleting || isSshDisconnected) {
        return
      }
      noteWorktreeRowHoverStart(worktree.id)
    },
    [isActive, isDeleting, isSshDisconnected, worktree.id]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // A press may still become a drag, so it only starts the warm mount; the click switches.
      if (
        event.pointerType !== 'mouse' ||
        event.button !== 0 ||
        // Modified presses select or open menus rather than switch.
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        isActive ||
        isDeleting ||
        isSshDisconnected
      ) {
        return
      }
      noteWorktreeRowPress(worktree.id)
    },
    [isActive, isDeleting, isSshDisconnected, worktree.id]
  )

  const handlePointerLeave = useCallback(() => {
    noteWorktreeRowHoverEnd(worktree.id)
  }, [worktree.id])
  // A row unmounted under the pointer never receives pointerleave.
  useEffect(() => () => noteWorktreeRowHoverEnd(worktree.id), [worktree.id])

  const handleRenameTitle = useCallback(
    // Store logging/refetch reverts failed optimistic renames; inline rename has no separate error surface.
    async (displayName: string): Promise<void> => {
      await updateWorktreeMeta(
        worktree.id,
        { displayName },
        { executionHostId: worktree.hostId ?? 'local' }
      )
    },
    [updateWorktreeMeta, worktree.hostId, worktree.id]
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
        executionHostId: worktree.hostId,
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
      worktree.hostId,
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
      setWorkspaceUnreadByUser(worktree.id, !worktree.isUnread, worktree.hostId ?? 'local')
    },
    [worktree.hostId, worktree.id, worktree.isUnread, setWorkspaceUnreadByUser]
  )

  return {
    handleClick,
    handlePointerDown,
    handlePointerEnter,
    handlePointerLeave,
    handleRenameTitle,
    handleDoubleClick,
    handleToggleUnreadQuick
  }
}
